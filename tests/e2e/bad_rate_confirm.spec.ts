import { test, expect, type Page } from "@playwright/test";
import {
  USDC,
  USDT,
  swapUrl,
  waitForDappReady,
  installMockWallet,
  ensureConnected,
} from "./helpers";
import { CG_IDS } from "../../web/src/dapp/cgIds";

// E2E: the dApp's bad-rate confirm gate. When the selected route's
// execution rate sits strictly worse than -10% vs the CoinGecko mid, clicking
// the primary Swap button must open a type-to-confirm modal BEFORE any
// build/wallet prompt; the user has to type exactly "confirm" to proceed.
//
// The rate deviation is forced deterministically by intercepting CoinGecko:
// USDC priced at $2 and USDT at $1 makes the mid say "1 USDC = 2 USDT" while the
// real live quote is ~1:1 — so cgDiffPct ≈ -50%, well past the -10 threshold.
// The live venue quote itself is real (mainnet 100k USDC→USDT), matching the
// other specs. /api/build is stubbed with a 500 (we only assert it fires, never
// actually build), and a mock EIP-1193 / EIP-6963 wallet reaches the connected
// state so the primary button shows the "Swap" verb.
//
// Serial + one shared page: connecting + the first live quote is the slow part,
// so tests A/B reuse it. Test C reloads (to drop the module-level per-token
// CoinGecko price cache) with a ≈0% price map so the gate must NOT trip.

// Must match playwright.config.ts (browser.newContext doesn't inherit the
// project `use.baseURL`, so the shared context needs it spelled out).
const BASE_URL = "http://127.0.0.1:5151";

const swapButton = (page: Page) =>
  page.getByRole("button", { name: "Swap", exact: true });
const gateDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Confirm a bad swap rate" });

test.describe.configure({ mode: "serial" });

test.describe("dApp · bad-rate confirm gate · 100k USDC→USDT mainnet", () => {
  let page: Page;
  // Fired /api/build request URLs (stubbed 500) — asserted per test.
  const buildRequests: string[] = [];
  // Mutable CoinGecko price map (lowercased address → usd), read by both route
  // handlers; tests flip it and reload to change the reference mid.
  const cgPrices: Record<string, number> = {
    [USDC.toLowerCase()]: 2.0,
    [USDT.toLowerCase()]: 1.0,
  };
  // The reworked hook prices tokens by CoinGecko coin id (batched simple/price)
  // when one is known, and only falls back to the per-contract token_price
  // endpoint otherwise. USDC/USDT both have ids on mainnet, so the app hits
  // simple/price?ids=… — invert CG_IDS[1] to answer that endpoint from the SAME
  // mutable price map, keeping both endpoints consistent and deterministic.
  const ID_TO_ADDR: Record<string, string> = {};
  const byAddr = CG_IDS[1]?.byAddr ?? {};
  for (const addr of Object.keys(cgPrices)) {
    const id = byAddr[addr];
    if (id) ID_TO_ADDR[id] = addr;
  }

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    page = await context.newPage();
    await installMockWallet(page);

    // CoinGecko mid via coin ids — the batched simple/price?ids=… endpoint the
    // reworked hook uses when the tokens have known ids. Map each id back to its
    // address and answer from the same mutable price map.
    await page.route(/\/api\/v3\/simple\/price\?/, async (route) => {
      const ids = (
        new URL(route.request().url()).searchParams.get("ids") ?? ""
      )
        .split(",")
        .filter(Boolean);
      const body: Record<string, { usd: number }> = {};
      for (const id of ids) {
        const addr = ID_TO_ADDR[id];
        const usd = addr != null ? cgPrices[addr] : undefined;
        if (usd != null) body[id] = { usd };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    // CoinGecko mid via per-contract token_price — the fallback for id-less
    // tokens (one contract per request, free-tier limit). Kept so any token
    // without an id still serves a deterministic price from the same map.
    await page.route(
      "https://api.coingecko.com/api/v3/simple/token_price/**",
      async (route) => {
        const addr = (
          new URL(route.request().url()).searchParams.get("contract_addresses") ??
          ""
        ).toLowerCase();
        const usd = cgPrices[addr];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(usd != null ? { [addr]: { usd } } : {}),
        });
      },
    );

    // Stub the build so no real tx/order is ever assembled; record every hit.
    await page.route(/\/api\/build/, async (route) => {
      buildRequests.push(route.request().url());
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "blocked by test" }),
      });
    });

    await page.goto(swapUrl());
    await waitForDappReady(page);
    await ensureConnected(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  // Wait until the summary's CoinGecko row shows a deviation ≤ -10% (two-digit
  // negative) — proves cgDiffPct is computed and the gate is armed before we
  // click Swap (avoids the race where the quote is in but CoinGecko isn't yet).
  async function waitForBadRateArmed(): Promise<void> {
    await expect(
      page.getByText(/-\d{2,}(\.\d+)?% vs CoinGecko/).first(),
    ).toBeVisible({ timeout: 60_000 });
  }

  test("A · gate blocks build until the exact word is typed", async () => {
    buildRequests.length = 0;
    await waitForBadRateArmed();

    // Click Swap → the gate opens and NOTHING is built yet.
    await swapButton(page).click();
    const dialog = gateDialog(page);
    await expect(dialog).toBeVisible();
    expect(buildRequests.length, "build must not fire before confirming").toBe(0);

    const input = dialog.getByLabel("Type confirm to proceed");
    const cont = dialog.getByRole("button", { name: "Continue" });

    // Case-sensitive, untrimmed: "Confirm" stays locked.
    await input.fill("Confirm");
    await expect(cont).toBeDisabled();

    // The exact literal unlocks Continue → clicking it builds exactly once.
    await input.fill("confirm");
    await expect(cont).toBeEnabled();
    await cont.click();

    await expect(dialog).toBeHidden();
    await expect
      .poll(() => buildRequests.length, {
        timeout: 15_000,
        message: "confirming should fire /api/build exactly once",
      })
      .toBe(1);
  });

  test("B · cancel dismisses without building and re-gates on the next click", async () => {
    buildRequests.length = 0;
    // The failed build in test A returned the button to the "Swap" verb.
    await expect(swapButton(page)).toBeEnabled({ timeout: 30_000 });
    await waitForBadRateArmed();

    // Open → Cancel → gone, no build.
    await swapButton(page).click();
    await expect(gateDialog(page)).toBeVisible();
    await gateDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(gateDialog(page)).toBeHidden();

    // No persistent "confirmed" state: clicking Swap again re-opens the gate.
    await swapButton(page).click();
    await expect(gateDialog(page)).toBeVisible();
    await gateDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(gateDialog(page)).toBeHidden();

    expect(buildRequests.length, "cancel must never build").toBe(0);
  });

  test("C · no gate when the deviation is within threshold", async () => {
    // ≈0% deviation now. Reload to drop the module-level per-token CoinGecko
    // price cache so the fresh price map is fetched.
    cgPrices[USDC.toLowerCase()] = 1.0;
    cgPrices[USDT.toLowerCase()] = 1.0;
    await page.reload();
    await waitForDappReady(page);
    await ensureConnected(page);

    buildRequests.length = 0;

    // Wait for the near-0% CoinGecko row so the gate has genuinely evaluated the
    // deviation and found it acceptable.
    await expect(
      page.getByText(/[+-]?0\.\d+% vs CoinGecko/).first(),
    ).toBeVisible({ timeout: 60_000 });

    // Swap goes straight to build — no gate.
    await swapButton(page).click();
    await expect
      .poll(() => buildRequests.length, {
        timeout: 15_000,
        message: "an in-threshold rate should build directly",
      })
      .toBe(1);
    await expect(gateDialog(page)).toHaveCount(0);
  });
});

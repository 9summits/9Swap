import { type Page, type Locator, expect } from "@playwright/test";
import { BUY_CAPABLE_VENUES } from "../../src/trade_side.ts";
import { isAsyncVenue } from "../../src/venues/types.ts";
import { vmeta } from "../../web/src/dapp/venues.ts";

// Canonical mainnet stablecoins for the fixed 100,000 USDC → USDT test trade.
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const AMOUNT = "100000";

// Plausibility window for the USDT output of a 100k USDC sell. Stable→stable is
// ~1:1; this band catches a venue returning garbage (wrong decimals, zero, a
// 10^N-scaled amount) without being so tight that normal slippage / a slightly
// depegged quote trips it.
export const MIN_OUT = 90_000;
export const MAX_OUT = 110_000;

// Every venue we expect to work, keyed by its backend name with the UI label
// (from web/src/dapp/venues.ts) the dApp renders. Requires ZEROEX_API_KEY for
// matcha, ONEINCH_API_KEY for 1inch/fusion, UNISWAP_API_KEY for uniswap/uniswapx.
// `skip` (when set) is the reason the spec skips that venue's test.
export type VenueCase = {
  name: string;
  label: string;
  kind: "sync" | "async";
  skip?: string;
};
const ODOS_GONE = "Odos discontinued its app and API on 2026-07-30 — venue disabled";
export const VENUE_CASES: VenueCase[] = [
  { name: "kyber", label: "KyberSwap", kind: "sync" },
  { name: "odos", label: "Odos", kind: "sync", skip: ODOS_GONE },
  { name: "odosv2", label: "Odos V2", kind: "sync", skip: ODOS_GONE },
  { name: "velora", label: "Velora", kind: "sync" },
  { name: "matcha", label: "0x · Matcha", kind: "sync" },
  { name: "1inch", label: "1inch", kind: "sync" },
  { name: "curve", label: "Curve", kind: "sync" },
  { name: "uniswap", label: "Uniswap", kind: "sync" },
  { name: "openocean", label: "OpenOcean", kind: "sync" },
  { name: "cow", label: "CoW Swap", kind: "async" },
  { name: "delta", label: "Delta", kind: "async" },
  { name: "uniswapx", label: "UniswapX", kind: "async" },
  { name: "fusion", label: "1inch Fusion", kind: "async" },
  { name: "ophis", label: "Ophis", kind: "async" },
];

// Deep-link straight to the fixed pair/amount on Ethereum (no `venues` param ⇒
// every venue starts enabled). The pair/amount setup is deterministic via the
// URL; the per-venue isolation is done by CLICKING through the settings UI.
export function swapUrl(): string {
  return `/?chain=eth&in=${USDC}&out=${USDT}&amount=${AMOUNT}`;
}

// Wait for the dApp to finish its first mount: the YOU PAY side resolved to USDC
// and the settings gear is interactive.
export async function waitForDappReady(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /USDC/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Swap settings" })).toBeVisible();
}

// Mock EIP-1193 / EIP-6963 wallet for specs that need a connected account.
// Address 0x1111…1111; RainbowKit lists it as "Mock Wallet".
export const WALLET = "0x1111111111111111111111111111111111111111";

// Minimal EIP-1193 provider + EIP-6963 announce, installed before any app code
// runs. wagmi's MIPD discovers it and RainbowKit lists it as "Mock Wallet".
// Reads (balances, block watch) route through it via the walletAware transport;
// they resolve to zero/empty — the button only needs connected + a live quote.
export function installMockWallet(page: Page): Promise<void> {
  return page.addInitScript((address: string) => {
    const CHAIN_ID = "0x1"; // mainnet — matches the eth deep link
    const listeners: Record<string, Array<(x: unknown) => void>> = {};
    const provider = {
      request: async ({ method }: { method: string; params?: unknown }) => {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return CHAIN_ID;
          case "net_version":
            return "1";
          case "wallet_getPermissions":
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "eth_getBalance":
            return "0x0";
          case "eth_blockNumber":
            return "0x1";
          case "eth_call":
            // 32-byte zero: a balanceOf() decode yields 0n instead of throwing.
            return "0x" + "0".repeat(64);
          case "eth_getBlockByNumber":
            return { number: "0x1", timestamp: "0x0", baseFeePerGas: "0x1" };
          default:
            // Unknown methods drop to the http() fallback transport — reject
            // loudly rather than returning a wrong value.
            throw Object.assign(new Error(`mock provider: unhandled ${method}`), {
              code: 4200,
            });
        }
      },
      on: (event: string, fn: (x: unknown) => void) => {
        (listeners[event] = listeners[event] || []).push(fn);
      },
      removeListener: (event: string, fn: (x: unknown) => void) => {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
      },
    };
    (window as unknown as { ethereum?: unknown }).ethereum = provider;

    // EIP-6963: announce a NAMED provider so RainbowKit shows "Mock Wallet".
    const info = {
      uuid: "00000000-0000-0000-0000-00000000beef",
      name: "Mock Wallet",
      icon:
        "data:image/svg+xml;base64," +
        "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PC9zdmc+",
      rdns: "com.mock.wallet",
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({ info, provider }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, WALLET);
}

// Open RainbowKit's modal and pick the mock wallet; resolves once no
// "Connect Wallet" trigger remains (header shows the account chip, the in-form
// button switches to the swap verb).
export async function connectMockWallet(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Connect Wallet/i })
    .first()
    .click();
  const option = page.getByRole("button", { name: /Mock Wallet/i }).first();
  await option.waitFor({ state: "visible", timeout: 15_000 });
  await option.click();
  await expect(page.getByRole("button", { name: /Connect Wallet/i })).toHaveCount(0, {
    timeout: 30_000,
  });
}

// The mock's eth_accounts answer makes wagmi discover-and-connect the injected
// 6963 provider on its own (no modal needed), and it re-connects the same way
// after a reload. Wait for the account chip (short(WALLET) → "0x1111…1111"); only
// drive RainbowKit's modal if auto-connect hasn't landed within the grace period.
export async function ensureConnected(page: Page): Promise<void> {
  const connected = await page
    .getByText(/0x1111.1111/)
    .first()
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!connected) await connectMockWallet(page);
}

// Click through the settings popover to leave EXACTLY ONE venue enabled. This is
// the "venue par venue, en mode click" core: open ⚙ → Disable all → toggle the
// target venue on → Done. The intent (async) master toggle defaults ON, so async
// venues aren't gated and can be enabled the same way.
export async function isolateVenue(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Swap settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Swap settings" });
  await expect(dialog).toBeVisible();

  const disableAll = dialog.getByRole("button", { name: "Disable all" });
  if (await disableAll.isVisible().catch(() => false)) {
    await disableAll.click();
  }

  const sw = dialog.getByRole("switch", { name: label, exact: true });
  await expect(
    sw,
    `settings has no venue switch labelled "${label}" — is the venue exposed by /api/mode?`,
  ).toBeVisible();
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
}

// The ranked route row for a venue. Each row is a role="button" whose accessible
// name folds in the venue label (logo alt + label span) plus the figures. With a
// single venue isolated there is exactly one row, so a label match is unambiguous.
export function routeRow(page: Page, label: string): Locator {
  return page.getByRole("button", { name: label });
}

// Pull the plausible USDT output (the one figure in the [MIN_OUT, MAX_OUT] band)
// out of a route row's text — the row also carries a gas $ value and a price-
// impact %, so we can't just grab the first number.
function plausibleOut(rowText: string): number | null {
  const nums = rowText.replace(/,/g, "").match(/\d+\.?\d*/g)?.map(Number) ?? [];
  return nums.find((n) => n >= MIN_OUT && n <= MAX_OUT) ?? null;
}

// Assert the isolated venue produced a working quote: its route row shows up and
// carries a sane ~100k USDT output. Returns that output for logging/annotation.
export async function expectVenueQuotes(page: Page, label: string): Promise<number> {
  const row = routeRow(page, label);
  await expect(row, `${label}: no route row appeared (venue failed to quote)`).toBeVisible({
    timeout: 60_000,
  });

  await expect
    .poll(async () => plausibleOut(await row.innerText()), {
      timeout: 60_000,
      message: `${label}: route row never showed a plausible USDT amount (~${AMOUNT})`,
    })
    .not.toBeNull();

  return plausibleOut(await row.innerText())!;
}

// ── exact-out (side=buy) helpers ────────────────────────────────────────────

// Exact-out venues — derived from BUY_CAPABLE_VENUES (never hardcode a mirror).
// cow / ophis are async — intent toggle defaults ON in the e2e harness.
export const BUY_VENUE_CASES: VenueCase[] = BUY_CAPABLE_VENUES.map((name) => ({
  name,
  label: vmeta(name).label,
  kind: isAsyncVenue(name) ? ("async" as const) : ("sync" as const),
}));

// Representative sell-only venue label (may still appear on buy via sell-refine
// when it meets the receive target at the native-buy seed).
export const SELL_ONLY_LABEL = "KyberSwap";

// The two amount inputs, by their stable aria-labels (SwapForm <AmountField>).
export function payInput(page: Page): Locator {
  return page.getByLabel("Amount to pay");
}
export function receiveInput(page: Page): Locator {
  return page.getByLabel("Amount to receive");
}

// Flip to exact-out: typing into the RECEIVE (tokenOut) field makes it the fixed
// leg (buy). Waits for the label flip only the buy side renders — "You pay (≈)"
// (the pay side becomes the derived/estimated leg).
export async function switchToBuy(page: Page, amount = AMOUNT): Promise<void> {
  const recv = receiveInput(page);
  await recv.click();
  await recv.fill(amount);
  await expect(
    page.getByText("You pay (≈)"),
    "buy round never engaged — the pay side never showed the (≈) estimate label",
  ).toBeVisible({ timeout: 30_000 });
}

// Flip back to exact-in: typing into the PAY (tokenIn) field. Waits for the
// sell-side label ("You receive (≈)").
export async function switchToSell(page: Page, amount = AMOUNT): Promise<void> {
  const pay = payInput(page);
  await pay.click();
  await pay.fill(amount);
  await expect(
    page.getByText("You receive (≈)"),
    "sell round never re-engaged — the receive side never showed the (≈) estimate label",
  ).toBeVisible({ timeout: 30_000 });
}

// Buy-side plausibility: the amountIn (tokenIn = USDC) needed to receive 100k
// USDT is ~100k, so the same [MIN_OUT, MAX_OUT] band catches a broken quote.
export async function expectVenueBuyQuote(page: Page, label: string): Promise<number> {
  const row = routeRow(page, label);
  await expect(
    row,
    `${label}: no buy route row appeared (venue failed to quote exact-out)`,
  ).toBeVisible({ timeout: 60_000 });

  await expect
    .poll(async () => plausibleOut(await row.innerText()), {
      timeout: 60_000,
      message: `${label}: buy route row never showed a plausible ~${AMOUNT} USDC amountIn`,
    })
    .not.toBeNull();

  return plausibleOut(await row.innerText())!;
}

// The best-ranked buy row (it alone carries the "Best" badge). buy ranks by
// amountIn ascending, so the best row is the cheapest to pay — return its
// amountIn for the ordering assertion.
export async function bestBuyRowAmount(page: Page): Promise<number> {
  const best = page.getByRole("button").filter({ hasText: "Best" }).first();
  await expect(best, "no best-ranked route row appeared").toBeVisible({ timeout: 60_000 });
  const amt = plausibleOut(await best.innerText());
  return amt!;
}

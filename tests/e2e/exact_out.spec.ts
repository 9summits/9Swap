import { test, expect } from "@playwright/test";
import {
  AMOUNT,
  BUY_VENUE_CASES,

  swapUrl,
  waitForDappReady,
  isolateVenue,
  switchToBuy,
  switchToSell,
  expectVenueBuyQuote,
  bestBuyRowAmount,
  routeRow,
  MIN_OUT,
  MAX_OUT,
} from "./helpers";

// E2E: exact-out (side=buy) on the 100,000 USDC ⇄ USDT mainnet pair, driven
// through the dApp's dual-edit UI. Same conventions as venues.spec.ts — the
// pair/amount is deep-linked for determinism; the trade direction and per-venue
// isolation are performed by real gestures (typing in the receive field, then
// clicking through the settings popover). No wallet: we stop at "does exact-out
// quote a working route", which is all that's reachable without a signer.

test.describe("dApp · exact-out (buy) · 100k USDC⇄USDT mainnet", () => {
  // The core dual-edit gesture: type into "You receive" → the round flips to
  // exact-out. Labels flip, routes rank by ascending amountIn (native buy +
  // optional sell-refine), and typing back into "You pay" restores exact-in.
  test("typing in You receive flips to buy and re-ranks by amountIn", async ({
    page,
  }) => {
    await page.goto(swapUrl());
    await waitForDappReady(page);

    // Starts exact-in: the RECEIVE side is the estimated (≈) leg.
    await expect(page.getByText("You receive (≈)")).toBeVisible();

    // Gesture under test: type the fixed receive amount → exact-out round.
    await switchToBuy(page);

    // Labels flipped: the PAY side is now the (≈) estimate, the RECEIVE side is
    // the exact fixed leg (no "≈").
    await expect(page.getByText("You pay (≈)")).toBeVisible();
    await expect(page.getByText("You receive", { exact: true })).toBeVisible();

    // Buy-capable venues rank by amountIn ascending: the best (cheapest to
    // pay) row anchors the list. Sell-only may also appear via sell-refine
    // when they meet the receive target at the seed pay. Routes
    // STREAM in, so poll until at least two buy-capable rows carry a
    // plausible ~100k USDC amountIn before ranking.
    const readBuyRows = async (): Promise<Array<{ label: string; amount: number }>> => {
      const out: Array<{ label: string; amount: number }> = [];
      for (const v of BUY_VENUE_CASES) {
        const row = routeRow(page, v.label);
        if ((await row.count()) === 0) continue;
        const txt = await row.first().innerText();
        const nums = txt.replace(/,/g, "").match(/\d+\.?\d*/g)?.map(Number) ?? [];
        const amt = nums.find((n) => n >= MIN_OUT && n <= MAX_OUT);
        if (amt != null) out.push({ label: v.label, amount: amt });
      }
      return out;
    };
    await expect
      .poll(async () => (await readBuyRows()).length, {
        timeout: 60_000,
        message: "fewer than 2 buy-capable venues ranked in the exact-out round",
      })
      .toBeGreaterThanOrEqual(2);

    const best = await bestBuyRowAmount(page);
    expect(best, `best amountIn ${best} outside the ~100k band`).toBeGreaterThanOrEqual(MIN_OUT);
    expect(best).toBeLessThanOrEqual(MAX_OUT);

    const present = await readBuyRows();
    // The best row is the cheapest to pay: every other buy-capable row's
    // amountIn must be ≥ it (ascending rank).
    for (const p of present) {
      expect(
        p.amount,
        `${p.label} amountIn ${p.amount} is below the best ${best} — buy ranking is not ascending`,
      ).toBeGreaterThanOrEqual(best);
    }

    // Flip back: typing in You pay restores exact-in (the receive side is (≈)
    // again). Sell-only venues can quote again here.
    await switchToSell(page);
    await expect(page.getByText("You receive (≈)")).toBeVisible();
  });

  // Per buy-capable venue: isolate it via the settings popover, flip to exact-
  // out, and assert it quotes a plausible ~100k USDC amountIn for 100k USDT out.
  for (const v of BUY_VENUE_CASES) {
    test(`${v.label} (${v.name}) quotes exact-out ${AMOUNT} USDT`, async ({ page }, testInfo) => {
      await page.goto(swapUrl());
      await waitForDappReady(page);

      // Leave exactly this venue enabled (settings → Disable all → toggle on).
      await isolateVenue(page, v.label);

      // Flip to exact-out and read the isolated venue's amountIn.
      await switchToBuy(page);

      const amountIn = await expectVenueBuyQuote(page, v.label);

      // Async venues advertise themselves as intent auctions in the row.
      if (v.kind === "async") {
        await expect(routeRow(page, v.label)).toContainText(/intent/i);
      }

      testInfo.annotations.push({
        type: "amountIn",
        description: `${v.label}: pay ${amountIn.toLocaleString("en-US")} USDC for ${AMOUNT} USDT`,
      });
      await testInfo.attach(`${v.name}-buy.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
});

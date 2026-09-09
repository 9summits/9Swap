import { test, expect } from "@playwright/test";
import {
  AMOUNT,
  VENUE_CASES,
  swapUrl,
  waitForDappReady,
  isolateVenue,
  expectVenueQuotes,
  routeRow,
} from "./helpers";

// E2E: 100,000 USDC → USDT on Ethereum mainnet, one venue at a time, driven
// entirely through the dApp UI (no wallet — we stop at "does this venue quote a
// working route"; signing/broadcasting needs a connected wallet).
//
// Setup (chain/pair/amount) is deep-linked for determinism; venue isolation is
// done by clicking through the settings popover, so each test proves the full
// click path: settings → pick one venue → see its ranked route.

test.describe("dApp · 100k USDC→USDT mainnet · per-venue", () => {
  // Baseline: the dApp boots, quotes the default (all) venues, and ranks at
  // least one route. If this fails, the per-venue failures below are just noise.
  test("smoke: loads and ranks routes with all venues", async ({ page }) => {
    await page.goto(swapUrl());
    await waitForDappReady(page);
    // At least one ranked route row carries a plausible ~100k USDT output.
    await expect
      .poll(
        async () => {
          const buttons = await page.getByRole("button").allInnerTexts();
          return buttons.some((t) => /9\d,\d{3}|10[01],\d{3}/.test(t.replace(/\s/g, "")));
        },
        { timeout: 60_000, message: "no ranked route with a ~100k USDT output appeared" },
      )
      .toBe(true);
  });

  for (const v of VENUE_CASES) {
    // A venue carrying `skip` is no longer offered by the dApp (see helpers.ts).
    const t = v.skip ? test.skip : test;
    t(`${v.label} (${v.name}) quotes ${AMOUNT} USDC→USDT`, async ({ page }, testInfo) => {
      await page.goto(swapUrl());
      await waitForDappReady(page);

      await isolateVenue(page, v.label);

      const out = await expectVenueQuotes(page, v.label);

      // Async venues advertise themselves as intent auctions in the row.
      if (v.kind === "async") {
        await expect(routeRow(page, v.label)).toContainText(/intent/i);
      }

      testInfo.annotations.push({
        type: "amountOut",
        description: `${v.label}: ${out.toLocaleString("en-US")} USDT`,
      });
      // Surface the per-venue result in the HTML report.
      await testInfo.attach(`${v.name}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
});

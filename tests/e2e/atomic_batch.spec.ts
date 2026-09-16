import { test, expect, type Page } from "@playwright/test";
import {
  AMOUNT,
  MOCK_BATCH_ID,
  MOCK_BATCH_TX_HASH,
  USDC,
  WALLET,
  swapUrl,
  waitForDappReady,
  installMockWallet,
  ensureConnected,
  isolateVenue,
  expectVenueQuotes,
} from "./helpers";

// E2E: a wallet whose wallet_getCapabilities reports atomic "supported" must
// get approve + swap as ONE wallet_sendCalls batch. Through a Safe the
// sequential path can never complete: eth_sendTransaction hands back a
// safeTxHash no public RPC will ever have a receipt for. Only the wallet is
// mocked; the quote and the /api/build payload are the battery's live trade.

const CHAIN_ID_HEX = "0x1";
const APPROVE_SELECTOR = "0x095ea7b3";

type SendCallsBundle = {
  atomicRequired: boolean;
  chainId: string;
  from: string;
  calls: { to: string; data: string; value?: string }[];
};

type BuiltPayload = {
  tx: { to: string; data: string };
  approval: { approveTx: { to: string; data: string } | null } | null;
};

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const shortBatchId = short(MOCK_BATCH_ID);
const shortTxHash = short(MOCK_BATCH_TX_HASH);

const sendCallsCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __mockSendCalls?: unknown[] }).__mockSendCalls
        ?.length ?? 0,
  );

test.describe("dApp · EIP-5792 atomic batch · 100k USDC→USDT mainnet", () => {
  test(`approve + swap ship as one wallet_sendCalls batch (${AMOUNT} USDC→USDT via KyberSwap)`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);

    await installMockWallet(page, { atomic: true });
    await page.goto(swapUrl());
    await waitForDappReady(page);
    await ensureConnected(page);

    await isolateVenue(page, "KyberSwap");
    await expectVenueQuotes(page, "KyberSwap");

    const buildResponse = page.waitForResponse(
      (r) => r.url().includes("/api/build") && r.ok(),
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Swap", exact: true }).click();
    const built = (await (await buildResponse).json()) as BuiltPayload;

    await expect
      .poll(() => sendCallsCount(page), {
        timeout: 60_000,
        message:
          "an atomic wallet must receive a wallet_sendCalls — check the dApp did not fall back to eth_sendTransaction",
      })
      .toBe(1);

    const bundle = await page.evaluate(
      () =>
        (window as unknown as { __mockSendCalls: SendCallsBundle[] })
          .__mockSendCalls[0]!,
    );
    const approveTx = built.approval?.approveTx;

    expect(
      approveTx,
      "0x1111…1111 has no USDC allowance, so the server must have built an approve tx",
    ).toBeTruthy();
    expect(
      bundle.calls.length,
      "approve and swap must travel as one 2-call batch",
    ).toBe(2);
    expect(
      bundle.calls[0]!.to.toLowerCase(),
      "call 0 must target the pay token (USDC) to approve it",
    ).toBe(USDC.toLowerCase());
    expect(
      bundle.calls[0]!.data.slice(0, 10).toLowerCase(),
      "call 0 must be ERC20 approve(address,uint256)",
    ).toBe(APPROVE_SELECTOR);
    expect(
      bundle.calls[0]!.data.toLowerCase(),
      "call 0 must be the approve the server built, calldata for calldata",
    ).toBe(approveTx!.data.toLowerCase());
    expect(
      bundle.calls[1]!.to.toLowerCase(),
      "call 1 must target the venue router from the build payload",
    ).toBe(built.tx.to.toLowerCase());
    expect(
      bundle.calls[1]!.to.toLowerCase(),
      "call 1 is the swap, so it cannot target the token being approved",
    ).not.toBe(USDC.toLowerCase());
    expect(
      bundle.calls[1]!.data.toLowerCase(),
      "call 1 must be the swap the server built, calldata for calldata",
    ).toBe(built.tx.data.toLowerCase());
    expect(bundle.chainId, "the batch must be pinned to mainnet").toBe(
      CHAIN_ID_HEX,
    );
    expect(
      bundle.from.toLowerCase(),
      "the batch must be sent from the connected account",
    ).toBe(WALLET.toLowerCase());
    expect(
      bundle.atomicRequired,
      "forceAtomic must reach the wallet: a wallet free to split the batch would broadcast the swap before the approval lands",
    ).toBe(true);

    await expect(
      page.getByText(
        `queued in your wallet · waiting for execution · ${shortBatchId}`,
      ),
      "the batch id returned by wallet_sendCalls must surface in the queued status line",
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: shortBatchId }),
      "a batch id is not a tx hash, so it must never be linked to the explorer",
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Batch queued · waiting for execution" }),
      "the form's action button must mirror the queued batch",
    ).toBeVisible();

    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __mockCallsStatusPolls?: number })
                .__mockCallsStatusPolls ?? 0,
          ),
        {
          timeout: 60_000,
          message:
            "wallet_getCallsStatus must be re-polled past the two pending answers a Safe gives while it waits for the remaining owners",
        },
      )
      .toBeGreaterThanOrEqual(3);

    await expect(
      page.getByRole("button", { name: "Swap confirmed" }),
      "the batch reported status 200, so the action button must leave its busy state",
    ).toBeVisible();
    await expect(
      page.getByText(/^\+ 100000(\.0+)? USDT$/),
      "the received amount must be decoded from the batch receipt's Transfer log (100,000 USDT), not fall back to the quoted estimate",
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: shortTxHash }),
      "once executed the batch must link the explorer at the receipt's tx hash",
    ).toBeVisible();

    expect(
      await sendCallsCount(page),
      "the batch must be fired once and only once — clickAtomic's guard must hold across the whole run",
    ).toBe(1);

    await testInfo.attach("atomic_batch.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
});

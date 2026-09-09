import { afterEach, describe, expect, test } from "bun:test";
import {
  quote as veloraQuote,
  buildTx as veloraBuildTx,
  veloraPriceAmount,
  veloraBuildAmountFields,
} from "../src/venues/velora.ts";
import {
  quote as matchaQuote,
  matchaAmountParam,
  normalizeMatchaQuoteAmounts,
  matchaRouteForSide,
} from "../src/venues/matcha.ts";
import { quote as deltaQuote, buildOrder as deltaBuildOrder } from "../src/venues/delta.ts";
import { resolveChain } from "../src/chains.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

// Velora + matcha exact-out (side=buy). 0x v2 exact-out support was
// verified live 2026-07-15 (mode:"exact-out", HTTP 200 on permit2 +
// allowance-holder), so matcha stays BUY_CAPABLE. Velora BUY verified same day.
// These tests exercise the pure request/response mapping (zero real network;
// the integration tests stub globalThis.fetch with inline probe fixtures).

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const eth = resolveChain("eth");
const SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";

process.env.ZEROEX_API_KEY ||= "test-zeroex-key";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- velora pure helpers -------------------------------------------------

describe("veloraPriceAmount", () => {
  test("sell: side=SELL, amount = amountIn (srcToken units)", () => {
    expect(veloraPriceAmount({ side: "sell", amountIn: 1000_000000n })).toEqual({
      side: "SELL",
      amount: "1000000000",
    });
  });

  test("buy: side=BUY, amount = amountOut (destToken units)", () => {
    expect(veloraPriceAmount({ side: "buy", amountOut: 5n * 10n ** 17n })).toEqual({
      side: "BUY",
      amount: "500000000000000000",
    });
  });

  test("rejects buy without amountOut / sell without amountIn", () => {
    expect(() => veloraPriceAmount({ side: "buy" })).toThrow(/amountOut/);
    expect(() => veloraPriceAmount({ side: "sell" })).toThrow(/amountIn/);
  });
});

describe("veloraBuildAmountFields", () => {
  test("sell fixes srcAmount", () => {
    expect(veloraBuildAmountFields({ side: "sell", amountIn: 42n })).toEqual({
      srcAmount: "42",
    });
  });

  test("buy fixes destAmount (never srcAmount)", () => {
    const f = veloraBuildAmountFields({ side: "buy", amountOut: 99n });
    expect(f).toEqual({ destAmount: "99" });
    expect("srcAmount" in f).toBe(false);
  });

  test("rejects missing fixed leg", () => {
    expect(() => veloraBuildAmountFields({ side: "buy" })).toThrow(/amountOut/);
    expect(() => veloraBuildAmountFields({ side: "sell" })).toThrow(/amountIn/);
  });
});

// ---- matcha pure helpers -------------------------------------------------

describe("matchaAmountParam", () => {
  test("sell → sellAmount", () => {
    expect(matchaAmountParam({ side: "sell", amountIn: 10n ** 18n })).toEqual({
      key: "sellAmount",
      value: "1000000000000000000",
    });
  });

  test("buy → buyAmount", () => {
    expect(matchaAmountParam({ side: "buy", amountOut: 1000_000000n })).toEqual({
      key: "buyAmount",
      value: "1000000000",
    });
  });

  test("rejects missing fixed leg", () => {
    expect(() => matchaAmountParam({ side: "buy" })).toThrow(/amountOut/);
    expect(() => matchaAmountParam({ side: "sell" })).toThrow(/amountIn/);
  });
});

describe("normalizeMatchaQuoteAmounts", () => {
  test("sell: amountIn = sellAmount, amountOut = buyAmount", () => {
    expect(
      normalizeMatchaQuoteAmounts({
        side: "sell",
        sellAmount: "500000000000000000",
        buyAmount: "940000000",
        fallbackIn: 0n,
      }),
    ).toEqual({ amountIn: "500000000000000000", amountOut: "940000000" });
  });

  test("sell: falls back to request amountIn when sellAmount absent", () => {
    expect(
      normalizeMatchaQuoteAmounts({
        side: "sell",
        buyAmount: "940000000",
        fallbackIn: 500000000000000000n,
      }),
    ).toEqual({ amountIn: "500000000000000000", amountOut: "940000000" });
  });

  test("buy: amountOut = buyAmount (fixed), amountIn = estimatedNetSellAmount", () => {
    expect(
      normalizeMatchaQuoteAmounts({
        side: "buy",
        buyAmount: "1000000000",
        estimatedNetSellAmount: "532395869222553609",
        fallbackIn: 0n,
      }),
    ).toEqual({ amountIn: "532395869222553609", amountOut: "1000000000" });
  });

  test("buy without estimatedNetSellAmount throws", () => {
    expect(() =>
      normalizeMatchaQuoteAmounts({ side: "buy", buyAmount: "1", fallbackIn: 0n }),
    ).toThrow(/estimatedNetSellAmount/);
  });
});

describe("matchaRouteForSide", () => {
  const route = { fills: [{ source: "A" }], tokens: [{ address: WETH, symbol: "WETH" }] };
  const forward = { fills: [{ source: "B" }], tokens: [{ address: USDC, symbol: "USDC" }] };

  test("sell reads .route", () => {
    expect(matchaRouteForSide({ route }, "sell")).toBe(route);
  });

  test("buy reads .routes.forward (never the refund leg)", () => {
    expect(matchaRouteForSide({ routes: { forward } }, "buy")).toBe(forward);
    // A sell-shaped `route` present alongside must be ignored for buy.
    expect(matchaRouteForSide({ route, routes: { forward } }, "buy")).toBe(forward);
  });
});

// ---- matcha buy quote integration (fetch stubbed) ------------------------

// Inline fixture mirrors the live /swap/allowance-holder/price exact-out
// response (same shape as permit2/price, probed 2026-07-15): buyAmount fixed,
// estimatedNetSellAmount = est. pay, routes.forward carries the user swap,
// routes.refund is 0x's over-buy return.
function zeroexExactOutFixture() {
  return {
    blockNumber: "20000000",
    buyAmount: "1000000000",
    buyToken: USDC,
    sellToken: WETH,
    mode: "exact-out",
    estimatedNetSellAmount: "532395869222553609",
    maxSellAmount: "537875904502779850",
    gas: "321298",
    gasPrice: "96813260",
    totalNetworkFee: "31105906811480",
    liquidityAvailable: true,
    routes: {
      forward: {
        fills: [
          { from: WETH, to: USDC, source: "Uniswap_V3", proportionBps: "10000" },
        ],
        tokens: [
          { address: WETH, symbol: "WETH" },
          { address: USDC, symbol: "USDC" },
        ],
      },
      refund: {
        fills: [{ from: USDC, to: WETH, source: "Uniswap_V3", proportionBps: "10000" }],
        tokens: [
          { address: USDC, symbol: "USDC" },
          { address: WETH, symbol: "WETH" },
        ],
      },
    },
  };
}

test("matcha buy quote: sends buyAmount, maps estimatedNetSellAmount → amountIn", async () => {
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify(zeroexExactOutFixture()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const q = await matchaQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 0n, // placeholder — buy fixes amountOut
    amountOut: 1000_000000n,
    side: "buy",
    slippageBps: 10,
  });

  const u = new URL(capturedUrl);
  expect(u.pathname).toBe("/swap/allowance-holder/price");
  expect(u.searchParams.get("buyAmount")).toBe("1000000000");
  expect(u.searchParams.get("sellAmount")).toBeNull();
  expect(u.searchParams.get("slippageBps")).toBe("10");
  expect(q.amountOut).toBe("1000000000");
  expect(q.amountIn).toBe("532395869222553609");
  // Hops come from routes.forward (WETH → USDC), not the refund leg.
  expect(q.hops).toHaveLength(1);
  expect(q.hops[0]!.tokenIn).toBe(WETH);
  expect(q.hops[0]!.tokenOut).toBe(USDC);
  // Split base is the estimated sell amount (amountIn placeholder is 0n).
  expect(q.hops[0]!.swapAmount).toBe("532395869222553609");
});

// ---- velora buy quote + build integration (fetch stubbed) ----------------

function veloraBuyPriceFixture() {
  return {
    priceRoute: {
      blockNumber: 20000000,
      network: 1,
      srcToken: USDC,
      srcDecimals: 6,
      srcAmount: "939945539",
      destToken: WETH,
      destDecimals: 18,
      destAmount: "500000000000000000",
      side: "BUY",
      bestRoute: [
        {
          percent: 100,
          swaps: [
            {
              srcToken: USDC,
              srcDecimals: 6,
              destToken: WETH,
              destDecimals: 18,
              swapExchanges: [
                {
                  exchange: "UniswapV3",
                  srcAmount: "939945539",
                  destAmount: "500000000000000000",
                  percent: 100,
                },
              ],
            },
          ],
        },
      ],
      gasCost: "150000",
      gasCostUSD: "5",
      srcUSD: "940",
      destUSD: "945",
      contractAddress: "0x6a000f20005980200259b80c5102003040001068",
      tokenTransferProxy: "0x216b4b4ba9f3e719726886d34a177484278bfcae",
    },
  };
}

test("velora sell quote: amountOut is destAmountAfterFee when partner fee is present", async () => {
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        priceRoute: {
          blockNumber: 20000000,
          network: 1,
          srcToken: WETH,
          srcDecimals: 18,
          srcAmount: "10000000000000000000",
          destToken: USDC,
          destDecimals: 6,
          destAmount: "20000000000",
          destAmountAfterFee: "19900000000",
          partnerFee: 50,
          side: "SELL",
          bestRoute: [],
          gasCost: "150000",
          contractAddress: "0x6a000f20005980200259b80c5102003040001068",
          tokenTransferProxy: "0x216b4b4ba9f3e719726886d34a177484278bfcae",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const q = await veloraQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 10n ** 19n,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
    side: "sell",
  });

  expect(q.amountOut).toBe("19900000000");
  expect(q.protocolFee).toEqual({
    raw: "100000000",
    sharePct: 0.5,
    side: "out",
  });
});

test("velora buy quote: sends side=BUY + amount=destAmount, maps srcAmount → amountIn", async () => {
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify(veloraBuyPriceFixture()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const q = await veloraQuote({
    chain: eth,
    tokenIn: USDC,
    tokenOut: WETH,
    amountIn: 0n, // placeholder
    tokenInDecimals: 6,
    tokenOutDecimals: 18,
    amountOut: 5n * 10n ** 17n,
    side: "buy",
  });

  const u = new URL(capturedUrl);
  expect(u.searchParams.get("side")).toBe("BUY");
  expect(u.searchParams.get("amount")).toBe("500000000000000000");
  expect(q.amountOut).toBe("500000000000000000"); // fixed target
  expect(q.amountIn).toBe("939945539"); // estimated pay
});

test("velora buy build: POST body fixes destAmount + slippage, never srcAmount", async () => {
  let capturedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : {};
    return new Response(
      JSON.stringify({
        to: "0x6a000f20005980200259b80c5102003040001068",
        from: SENDER,
        data: "0xdeadbeef",
        value: "0",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const quote: NormalizedQuote = {
    venue: "velora",
    amountIn: "939945539",
    amountOut: "500000000000000000",
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: "0x6a000f20005980200259b80c5102003040001068",
    hops: [],
    tokenHints: new Map(),
    raw: veloraBuyPriceFixture(),
  };

  const tx = await veloraBuildTx({
    chain: eth,
    tokenIn: USDC,
    tokenOut: WETH,
    tokenInDecimals: 6,
    tokenOutDecimals: 18,
    amountIn: 0n,
    amountOut: 5n * 10n ** 17n,
    sender: SENDER,
    slippageBps: 50,
    quote,
    side: "buy",
  });

  expect(capturedBody.destAmount).toBe("500000000000000000");
  expect(capturedBody.srcAmount).toBeUndefined();
  expect(capturedBody.slippage).toBe(50);
  // Spender is the tokenTransferProxy from the priceRoute, not tx.to.
  expect(tx.spender).toBe("0x216b4b4ba9f3e719726886d34a177484278bfcae");
});

// ---- delta stays sell-only ------------------------------------------------

describe("delta rejects exact-out", () => {
  test("quote(side=buy) throws sell-only (no network)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("delta buy must not hit network");
    }) as unknown as typeof fetch;
    await expect(
      deltaQuote({
        chain: eth,
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: 0n,
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        side: "buy",
      }),
    ).rejects.toThrow(/sell-only/);
  });

  test("buildOrder(side=buy) throws sell-only (no network)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("delta buy must not hit network");
    }) as unknown as typeof fetch;
    const quote: NormalizedQuote = {
      venue: "delta",
      amountIn: "0",
      amountOut: "1000000000",
      amountInUsd: null,
      amountOutUsd: null,
      gasUnits: null,
      gasPriceWei: null,
      gasUsd: null,
      router: null,
      hops: [],
      tokenHints: new Map(),
      raw: {},
    };
    await expect(
      deltaBuildOrder({
        chain: eth,
        tokenIn: WETH,
        tokenOut: USDC,
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        amountIn: 0n,
        amountOut: 1000_000000n,
        sender: SENDER,
        slippageBps: 50,
        quote,
        side: "buy",
      }),
    ).rejects.toThrow(/sell-only/);
  });
});

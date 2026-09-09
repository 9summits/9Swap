import { afterAll, afterEach, describe, expect, test, mock } from "bun:test";
import { build, type NormalizedQuote } from "../src/venues/index.ts";
import { resolveChain } from "../src/chains.ts";

// mock.module is process-wide; mock.restore() does not undo it (bun:test docs).
// Snapshot real exports before the stub and put them back so later files
// (send_not_wrap) import the real buildForVenue, not 0x6a000f…1068.
const realCore = { ...(await import("../src/core.ts")) };
afterAll(() => {
  mock.module("../src/core.ts", () => realCore);
});

// Build-side plumbing. Threads `side` + `amountOut` from the
// callers (CLI -d and the dApp /api/build handler) through core.buildForVenue
// into the dispatcher build(). Without it, adapters that read params.side
// (velora / matcha) silently fall back to sell and emit exact-in calldata for
// an exact-out intent. These tests prove, with zero real network:
//   (a) build("cow"|"ophis", {side:"buy", amountOut}) → a kind=buy order with
//       buyAmount = the fixed target;
//   (the fix) build("velora", …) forwards side so the built /transactions body
//       fixes destAmount (buy) vs srcAmount (sell);
//   (b) handleBuild(side=buy) hands side + amountOut to buildForVenue;
//   (c) the sell path is unchanged.

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const eth = resolveChain("eth");
const SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const TARGET = 5n * 10n ** 17n; // 0.5 WETH, the exact-out target

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function baseQuote(over: Partial<NormalizedQuote>): NormalizedQuote {
  return {
    venue: "cow",
    amountIn: "940000000",
    amountOut: TARGET.toString(),
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: null,
    hops: [],
    tokenHints: new Map(),
    raw: null,
    ...over,
  };
}

// ── (a) dispatcher build("cow", side=buy) → kind=buy order, buyAmount=target ──

describe('build("cow", side=buy)', () => {
  test("produces a kind=buy order whose buyAmount is the fixed target", async () => {
    // cow.buildOrder reuses the quote envelope (no re-quote / no network).
    const quote = baseQuote({
      venue: "cow",
      raw: {
        quote: {
          sellToken: USDC,
          buyToken: WETH,
          receiver: SENDER,
          sellAmount: "940000000",
          buyAmount: TARGET.toString(),
          validTo: 2_000_000_000,
          appData: "{}",
          appDataHash:
            "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d",
          feeAmount: "0",
          kind: "buy",
          partiallyFillable: false,
          sellTokenBalance: "erc20",
          buyTokenBalance: "erc20",
          signingScheme: "eip712",
        },
        id: 42,
      },
    });

    const r = await build("cow", {
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      amountIn: 940_000_000n,
      amountOut: TARGET,
      side: "buy",
      sender: SENDER,
      slippageBps: 10,
      quote,
    });

    expect(r.kind).toBe("order");
    if (r.kind !== "order") throw new Error("unreachable");
    expect(r.typedData.message.kind).toBe("buy");
    // Buy orders keep buyAmount exact (slippage lands on sellAmount).
    expect(r.typedData.message.buyAmount).toBe(TARGET.toString());
    expect((r.typedData.message.buyToken as string).toLowerCase()).toBe(WETH);
    expect((r.typedData.message.sellToken as string).toLowerCase()).toBe(USDC);
  });
});

// ── (a) dispatcher build("ophis", side=buy) → kind=buy order, buyAmount=target ─

describe('build("ophis", side=buy)', () => {
  test("re-quotes buy-shaped and signs a kind=buy order at the fixed target", async () => {
    // ophis.buildOrder enrolls the trader (GET /tier/<wallet>) then re-quotes
    // (POST /api/v1/quote). Both go through globalThis.fetch — stub by URL.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tier/")) {
        return new Response(JSON.stringify({ tier: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/quote")) {
        return new Response(
          JSON.stringify({
            quote: {
              sellToken: USDC,
              buyToken: WETH,
              receiver: SENDER,
              sellAmount: "940000000",
              buyAmount: TARGET.toString(),
              validTo: 2_000_000_000,
              appData: "{}",
              appDataHash:
                "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d",
              feeAmount: "0",
              kind: "buy",
              partiallyFillable: false,
              sellTokenBalance: "erc20",
              buyTokenBalance: "erc20",
              signingScheme: "eip712",
            },
            id: 7,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    // Prior quote carries a buy envelope so buildOrder infers orderSide=buy.
    const quote = baseQuote({
      venue: "ophis",
      raw: { quote: { kind: "buy", buyAmount: TARGET.toString() } },
    });

    const r = await build("ophis", {
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      amountIn: 940_000_000n,
      amountOut: TARGET,
      side: "buy",
      sender: SENDER,
      slippageBps: 10,
      quote,
    });

    expect(r.kind).toBe("order");
    if (r.kind !== "order") throw new Error("unreachable");
    expect(r.typedData.message.kind).toBe("buy");
    expect(r.typedData.message.buyAmount).toBe(TARGET.toString());
  });
});

// ── (the fix) dispatcher build("velora", …) forwards side into the tx body ────

describe('build("velora") threads side into the built tx', () => {
  function veloraPriceRoute(side: "SELL" | "BUY") {
    return {
      priceRoute: {
        blockNumber: 20_000_000,
        network: 1,
        srcToken: USDC,
        srcDecimals: 6,
        srcAmount: "940000000",
        destToken: WETH,
        destDecimals: 18,
        destAmount: TARGET.toString(),
        side,
        bestRoute: [],
        contractAddress: "0x6a000f20005980200259b80c5102003040001068",
        tokenTransferProxy: "0x216b4b4ba9f3e719726886d34a177484278bfcae",
      },
    };
  }

  async function captureBuildBody(params: {
    side: "sell" | "buy";
    amountIn: bigint;
    amountOut?: bigint;
    priceSide: "SELL" | "BUY";
  }): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      body = init?.body ? JSON.parse(String(init.body)) : {};
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

    await build("velora", {
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      amountIn: params.amountIn,
      amountOut: params.amountOut,
      side: params.side,
      sender: SENDER,
      slippageBps: 50,
      quote: baseQuote({ venue: "velora", raw: veloraPriceRoute(params.priceSide) }),
    });
    return body;
  }

  test("side=buy → destAmount fixed, srcAmount absent", async () => {
    const body = await captureBuildBody({
      side: "buy",
      amountIn: 940_000_000n,
      amountOut: TARGET,
      priceSide: "BUY",
    });
    expect(body.destAmount).toBe(TARGET.toString());
    expect(body.srcAmount).toBeUndefined();
    expect(body.slippage).toBe(50);
  });

  test("side=sell → srcAmount fixed, destAmount absent (unchanged)", async () => {
    const body = await captureBuildBody({
      side: "sell",
      amountIn: 1_000_000_000n,
      priceSide: "SELL",
    });
    expect(body.srcAmount).toBe("1000000000");
    expect(body.destAmount).toBeUndefined();
  });
});

// ── (b)+(c) handleBuild hands side + amountOut to buildForVenue ────────────────

describe("handleBuild → buildForVenue plumbing", () => {
  test("side=buy passes side+amountOut; side=sell passes side=sell, amountOut undefined", async () => {
    const calls: Array<Record<string, unknown>> = [];

    mock.module("../src/core.ts", () => ({
      resolveTokenPair: async () => {
        throw new Error("not used");
      },
      resolveOneToken: async () => {
        throw new Error("not used");
      },
      tokenList: async () => [],
      quoteAll: async () => {
        throw new Error("not used");
      },
      quoteAllStream: async function* () {},
      // Return a buy-shaped quote (estimated amountIn, fixed amountOut).
      quoteSingle: async (p: Record<string, unknown>) =>
        baseQuote({
          venue: "velora",
          amountIn: "940000000",
          amountOut: p.side === "buy" ? String(p.amountOut) : TARGET.toString(),
        }),
      buildForVenue: async (p: Record<string, unknown>) => {
        calls.push(p);
        // Minimal valid tx BuildResult so handleBuild finishes.
        return {
          kind: "tx",
          to: "0x6a000f20005980200259b80c5102003040001068",
          from: p.sender,
          data: "0xdeadbeef",
          value: "0",
          gas: null,
          gasPrice: null,
          maxPriorityFeePerGas: null,
          spender: "0x6a000f20005980200259b80c5102003040001068",
          chainId: 1,
        };
      },
      checkAllowance: async () => {
        throw new Error("not used");
      },
      // Skip the on-chain allowance read (buildForVenue is what we assert on).
      needsAllowanceCheck: () => false,
      assemble: async () => {
        throw new Error("not used");
      },
      resolveRouteHops: async () => [],
      listChains: () => [],
      listVenues: () => [],
    }));

    const { handleBuild } = await import(
      `../src/server/handlers.ts?t=${Date.now()}`
    );

    const tokenIn = { address: USDC, symbol: "USDC", decimals: 6 };
    const tokenOut = { address: WETH, symbol: "WETH", decimals: 18 };
    const buildReq = (amount: { amountIn?: string; amountOut?: string }) =>
      new Request("http://local/api/build", {
        method: "POST",
        body: JSON.stringify({
          chain: "eth",
          venue: "velora",
          sender: SENDER,
          tokenIn,
          tokenOut,
          slippageBps: 50,
          ...amount,
        }),
      });

    // Buy: side + amountOut (the fixed target) reach buildForVenue.
    const buy = await handleBuild(buildReq({ amountOut: TARGET.toString() }));
    expect(buy.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.side).toBe("buy");
    expect(calls[0]!.amountOut).toBe(TARGET);

    // Sell: side=sell, amountOut undefined (byte-for-byte legacy behaviour).
    calls.length = 0;
    const sell = await handleBuild(buildReq({ amountIn: "1000000000" }));
    expect(sell.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.side).toBe("sell");
    expect(calls[0]!.amountOut).toBeUndefined();
  });
});

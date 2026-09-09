import { afterEach, expect, test } from "bun:test";
import { quote as uniswapQuote, buildTx as uniswapBuildTx } from "../src/venues/uniswap.ts";
import { resolveChain } from "../src/chains.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

// Uniswap EXACT_OUTPUT (side=buy) must:
// 1. POST type: "EXACT_OUTPUT" with amount = fixed tokenOut
// 2. Never take the exact-in SwapRouter02 / V2 hand-rolled fast path on build
//    (would emit exactInput* / swapExactTokensForTokens for a buy → critical bug)

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const eth = resolveChain("eth");
const SENDER = "0x1111111111111111111111111111111111111111";
const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const SEL_EXACT_INPUT_SINGLE = "0x04e45aaf";

process.env.UNISWAP_API_KEY ||= "test-uniswap-key";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Captured = { url: string; body: Record<string, unknown> };

function classicQuoteBody(opts: {
  tradeType: "EXACT_INPUT" | "EXACT_OUTPUT";
  amountIn: string;
  amountOut: string;
  withPermit?: boolean;
}) {
  return {
    quote: {
      chainId: 1,
      swapper: "0x000000000000000000000000000000000000dEaD",
      tradeType: opts.tradeType,
      route: [
        [
          {
            type: "v3-pool",
            address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
            fee: "500",
            tokenIn: { address: WETH, symbol: "WETH" },
            tokenOut: { address: USDC, symbol: "USDC" },
            amountIn: opts.amountIn,
            amountOut: opts.amountOut,
          },
        ],
      ],
      input: { amount: opts.amountIn, token: WETH },
      output: { amount: opts.amountOut, token: USDC },
      slippage: 0.1,
      gasFee: "21000000000000",
      gasFeeUSD: "0.05",
      gasUseEstimate: "150000",
      quoteId: "q-test",
    },
    permitData: opts.withPermit
      ? {
          domain: {
            name: "Permit2",
            chainId: 1,
            verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
          },
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            PermitSingle: [
              { name: "details", type: "PermitDetails" },
              { name: "spender", type: "address" },
              { name: "sigDeadline", type: "uint256" },
            ],
            PermitDetails: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          values: {
            details: {
              token: WETH,
              amount: "0xffffffffffffffffffffffffffffffffffffffff",
              expiration: "281474976710655",
              nonce: "0",
            },
            spender: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
            sigDeadline: "9999999999",
          },
        }
      : undefined,
    routing: "CLASSIC",
  };
}

test("sell (default): /v1/quote body is EXACT_INPUT with amountIn", async () => {
  const captured: Captured[] = [];
  const amountIn = 10n ** 18n; // 1 WETH
  const amountOut = "3000000000"; // 3000 USDC
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    captured.push({ url, body });
    return new Response(
      JSON.stringify(
        classicQuoteBody({
          tradeType: "EXACT_INPUT",
          amountIn: amountIn.toString(),
          amountOut,
        }),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const q = await uniswapQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn,
    slippageBps: 10,
  });

  expect(captured).toHaveLength(1);
  expect(captured[0]!.url).toContain("/v1/quote");
  expect(captured[0]!.body.type).toBe("EXACT_INPUT");
  expect(captured[0]!.body.amount).toBe(amountIn.toString());
  expect(q.amountIn).toBe(amountIn.toString());
  expect(q.amountOut).toBe(amountOut);
});

test("buy: /v1/quote body is EXACT_OUTPUT with amount = amountOut", async () => {
  const captured: Captured[] = [];
  const amountOut = 10n ** 18n; // want 1 WETH out — here USDC→WETH so flip tokens for realism
  const tokenIn = USDC;
  const tokenOut = WETH;
  const quotedIn = "3001000000"; // ~3001 USDC

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    captured.push({ url, body });
    return new Response(
      JSON.stringify({
        quote: {
          chainId: 1,
          swapper: "0x000000000000000000000000000000000000dEaD",
          tradeType: "EXACT_OUTPUT",
          route: [
            [
              {
                type: "v3-pool",
                address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
                fee: "500",
                tokenIn: { address: tokenIn, symbol: "USDC" },
                tokenOut: { address: tokenOut, symbol: "WETH" },
                amountIn: quotedIn,
                amountOut: amountOut.toString(),
              },
            ],
          ],
          input: { amount: quotedIn, token: tokenIn },
          output: { amount: amountOut.toString(), token: tokenOut },
          slippage: 0.1,
          gasUseEstimate: "150000",
          gasFee: "21000000000000",
          gasFeeUSD: "0.05",
        },
        routing: "CLASSIC",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const q = await uniswapQuote({
    chain: eth,
    tokenIn,
    tokenOut,
    amountIn: 0n, // sell path field unused when side=buy
    amountOut,
    side: "buy",
    slippageBps: 10,
  });

  expect(captured).toHaveLength(1);
  expect(captured[0]!.body.type).toBe("EXACT_OUTPUT");
  expect(captured[0]!.body.amount).toBe(amountOut.toString());
  expect(q.amountOut).toBe(amountOut.toString());
  expect(q.amountIn).toBe(quotedIn);
});

test("buy build: pure V3 single-hop MUST NOT hand-roll exactInputSingle", async () => {
  // A sell on this route shape would take SwapRouter02 exactInputSingle.
  // Buy must force Path A (/v1/swap) even though the route looks hand-rollable.
  const amountOut = "3000000000";
  const amountIn = (10n ** 18n).toString();
  const captured: Captured[] = [];

  const quote: NormalizedQuote = {
    venue: "uniswap",
    amountIn,
    amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: 150000,
    gasPriceWei: null,
    gasUsd: null,
    router: SWAP_ROUTER_02,
    hops: [],
    tokenHints: new Map(),
    raw: {
      quote: classicQuoteBody({
        tradeType: "EXACT_OUTPUT",
        amountIn,
        amountOut,
      }).quote,
      permitData: null,
      routing: "CLASSIC",
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    captured.push({ url, body });
    if (url.includes("/v1/quote")) {
      // Re-quote with real sender: still EXACT_OUTPUT, no permit (native-out style skip)
      return new Response(
        JSON.stringify(
          classicQuoteBody({
            tradeType: "EXACT_OUTPUT",
            amountIn,
            amountOut,
            withPermit: true,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/swap")) {
      return new Response(
        JSON.stringify({
          swap: {
            to: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
            from: SENDER,
            data: "0xdeadbeef",
            value: "0",
            chainId: 1,
            gasLimit: "200000",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  const built = await uniswapBuildTx({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
    amountIn: BigInt(amountIn),
    sender: SENDER,
    slippageBps: 10,
    quote,
    side: "buy",
  });

  // Must not be a hand-rolled SwapRouter02 exact-in tx.
  if (built.kind === "tx") {
    expect(built.to.toLowerCase()).not.toBe(SWAP_ROUTER_02.toLowerCase());
    expect(built.data.toLowerCase().startsWith(SEL_EXACT_INPUT_SINGLE)).toBe(false);
  } else {
    expect(built.kind).toBe("permit-tx");
  }

  // Re-quote for Path A must re-assert EXACT_OUTPUT (not EXACT_INPUT).
  const quoteCalls = captured.filter((c) => c.url.includes("/v1/quote"));
  expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
  for (const c of quoteCalls) {
    expect(c.body.type).toBe("EXACT_OUTPUT");
    expect(c.body.amount).toBe(amountOut);
  }
});

test("EXACT_OUTPUT tradeType without side still forces Path A (defense in depth)", async () => {
  // Even if the orchestrator forgets side=buy, quote.raw.tradeType must
  // still block the exact-in hand-roll.
  const amountOut = "3000000000";
  const amountIn = (10n ** 18n).toString();
  const captured: Captured[] = [];
  const quote: NormalizedQuote = {
    venue: "uniswap",
    amountIn,
    amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: 150000,
    gasPriceWei: null,
    gasUsd: null,
    router: SWAP_ROUTER_02,
    hops: [],
    tokenHints: new Map(),
    raw: {
      quote: classicQuoteBody({
        tradeType: "EXACT_OUTPUT",
        amountIn,
        amountOut,
      }).quote,
      permitData: null,
      routing: "CLASSIC",
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    captured.push({ url, body });
    if (url.includes("/v1/quote")) {
      return new Response(
        JSON.stringify(
          classicQuoteBody({
            tradeType: "EXACT_OUTPUT",
            amountIn,
            amountOut,
            withPermit: true,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;

  const built = await uniswapBuildTx({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
    amountIn: BigInt(amountIn),
    sender: SENDER,
    slippageBps: 10,
    quote,
    // deliberately omit side
  });

  expect(built.kind).toBe("permit-tx");
  const quoteCalls = captured.filter((c) => c.url.includes("/v1/quote"));
  expect(quoteCalls.length).toBeGreaterThanOrEqual(1);
  for (const c of quoteCalls) {
    expect(c.body.type).toBe("EXACT_OUTPUT");
    expect(c.body.amount).toBe(amountOut);
  }
});

test("sell build: pure V3 single-hop still hand-rolls exactInputSingle", async () => {
  const amountIn = 10n ** 18n;
  const amountOut = "3000000000";
  const quote: NormalizedQuote = {
    venue: "uniswap",
    amountIn: amountIn.toString(),
    amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: 150000,
    gasPriceWei: null,
    gasUsd: null,
    router: SWAP_ROUTER_02,
    hops: [],
    tokenHints: new Map(),
    raw: {
      quote: classicQuoteBody({
        tradeType: "EXACT_INPUT",
        amountIn: amountIn.toString(),
        amountOut,
      }).quote,
      permitData: null,
      routing: "CLASSIC",
    },
  };

  // No network expected for hand-roll
  globalThis.fetch = (async () => {
    throw new Error("sell hand-roll must not hit network");
  }) as unknown as typeof fetch;

  const built = await uniswapBuildTx({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
    amountIn,
    sender: SENDER,
    slippageBps: 10,
    quote,
    side: "sell",
  });

  expect(built.kind).toBe("tx");
  if (built.kind === "tx") {
    expect(built.to.toLowerCase()).toBe(SWAP_ROUTER_02.toLowerCase());
    expect(built.data.toLowerCase().startsWith(SEL_EXACT_INPUT_SINGLE)).toBe(true);
  }
});

import { afterEach, expect, test } from "bun:test";
import { quote as openoceanQuote } from "../src/venues/openocean.ts";
import { quote as oneinchQuote } from "../src/venues/oneinch.ts";
import { resolveChain } from "../src/chains.ts";

// Downstream hops (tokenIn = an intermediate token) carry a swapAmount that is
// only a relative weight denominated in the ROUTE input token — venues like
// openocean / 1inch expose split ratios but no intermediate amounts. Those
// hops must be flagged approxAmount so renderers never display the weight as
// an absolute amount (10% of 10000 WETH rendered as 10^13 WBTC).

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const eth = resolveChain("eth");
// 1inch hard-fails without a key before ever hitting the (stubbed) network.
process.env.ONEINCH_API_KEY ||= "test-key";
process.env.OPENOCEAN_API_KEY ||= "test-key";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("openocean: downstream hop is flagged approxAmount, first hop is not", async () => {
  // 90% WETH→USDT direct, 10% WETH→WBTC→USDT (two chained subRoutes).
  stubFetch({
    code: 200,
    data: {
      inToken: { address: WETH, symbol: "WETH", decimals: 18 },
      outToken: { address: USDT, symbol: "USDT", decimals: 6 },
      inAmount: (10000n * 10n ** 18n).toString(),
      outAmount: "15983201765992",
      estimatedGas: "2209578",
      path: {
        from: WETH,
        to: USDT,
        routes: [
          {
            percentage: 90,
            subRoutes: [{ from: WETH, to: USDT, dexes: [{ dex: "UniswapV3" }] }],
          },
          {
            percentage: 10,
            subRoutes: [
              { from: WETH, to: WBTC, dexes: [{ dex: "UniswapV3" }] },
              { from: WBTC, to: USDT, dexes: [{ dex: "UniswapV4" }] },
            ],
          },
        ],
      },
    },
  });

  const q = await openoceanQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDT,
    amountIn: 10000n * 10n ** 18n,
    slippageBps: 10,
  });

  const direct = q.hops.find((h) => h.tokenIn === WETH && h.tokenOut === USDT)!;
  const firstLeg = q.hops.find((h) => h.tokenIn === WETH && h.tokenOut === WBTC)!;
  const downstream = q.hops.find((h) => h.tokenIn === WBTC)!;

  // First hops of each chain genuinely swap a share of amountIn (WETH units).
  expect(direct.approxAmount).toBeFalsy();
  expect(firstLeg.approxAmount).toBeFalsy();
  expect(firstLeg.swapAmount).toBe((1000n * 10n ** 18n).toString());
  // The WBTC→USDT hop's swapAmount is a WETH-denominated weight, not WBTC.
  expect(downstream.approxAmount).toBe(true);
});

test("1inch: hops beyond level 0 are flagged approxAmount", async () => {
  stubFetch({
    dstAmount: "15983201765992",
    gas: 2209578,
    protocols: [
      [
        // level 0 — splits of the WETH input (real amounts).
        [
          { name: "UNISWAP_V3", part: 90, fromTokenAddress: WETH, toTokenAddress: USDT },
          { name: "UNISWAP_V3", part: 10, fromTokenAddress: WETH, toTokenAddress: WBTC },
        ],
        // level 1 — WBTC intermediate; ratio known, absolute amount not.
        [{ name: "UNISWAP_V4", part: 100, fromTokenAddress: WBTC, toTokenAddress: USDT }],
      ],
    ],
  });

  const q = await oneinchQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDT,
    amountIn: 10000n * 10n ** 18n,
    slippageBps: 10,
  });

  const level0 = q.hops.filter((h) => h.tokenIn === WETH);
  const level1 = q.hops.find((h) => h.tokenIn === WBTC)!;
  for (const h of level0) expect(h.approxAmount).toBeFalsy();
  expect(level1.approxAmount).toBe(true);
});

test("1inch: HyperEVM (999) is on the whitelist", async () => {
  stubFetch({ dstAmount: "79964830", gas: 317762, protocols: [] });
  const q = await oneinchQuote({
    chain: resolveChain("hype"),
    tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    tokenOut: "0xb88339cb7199b77e23db6e890353e22632ba630f",
    amountIn: 10n ** 18n,
  });
  expect(q.amountOut).toBe("79964830");
  expect(q.venue).toBe("1inch");
});

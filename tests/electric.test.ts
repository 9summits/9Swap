import { afterEach, describe, expect, test } from "bun:test";
import { resolveChain } from "../src/chains.ts";
import {
  availableVenues,
  buildTx,
  fetchAllQuotes,
  fetchQuote,
  skippedVenues,
} from "../src/venues/index.ts";
import {
  quote as electricQuote,
  setErouterRunnerForTests,
} from "../src/venues/electric.ts";
import { UnsupportedChainError } from "../src/venues/types.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

const eth = resolveChain("eth");
const base = resolveChain("base");
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const POOL = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
const ROUTER = "0xf5438dafc165b466f4a61ce57bd3aa59bcd5979e";
const SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";

const FIXTURE = {
  version: 1,
  result: { amount_out: "4000000000000000000", verified_out: "4000000000000000000" },
  legs: [
    {
      kind: "SWAP_STABLE",
      target: POOL,
      token_in: USDC,
      token_out: USDT,
      symbol_in: "USDC",
      symbol_out: "USDT",
      amount_in: "5000000000",
      amount_out: "4999000000",
      pool_name: "3pool",
    },
    {
      kind: "SWAP_STABLE",
      target: POOL,
      token_in: USDC,
      token_out: USDT,
      symbol_in: "USDC",
      symbol_out: "USDT",
      amount_in: "5000000000",
      amount_out: "4999000000",
      pool_name: "3pool",
    },
    {
      kind: "SWAP_CRYPTO",
      target: "0x7f4188347d82f6dbd8f62c98e0b602d8b7d13a5e",
      token_in: USDT,
      token_out: WETH,
      symbol_in: "USDT",
      symbol_out: "WETH",
      amount_in: "9998000000",
      amount_out: "4000000000000000000",
      pool_name: "TricryptoUSDC",
    },
  ],
  call: {
    to: ROUTER,
    calldata: "0xabcdef",
    token_in: USDC,
    guaranteed_out: "3980000000000000000",
  },
};

afterEach(() => {
  setErouterRunnerForTests(null);
});

describe("electric is opt-in", () => {
  test("absent from -v all / availableVenues", () => {
    expect(availableVenues({ allowAsync: true })).not.toContain("electric");
    expect(availableVenues({ allowAsync: true, side: "sell" })).not.toContain(
      "electric",
    );
  });

  test("not reported as skipped", () => {
    expect(skippedVenues({ allowAsync: true }).some((s) => s.venue === "electric")).toBe(
      false,
    );
  });

  test("explicit -v electric reaches the adapter", async () => {
    setErouterRunnerForTests(async () => FIXTURE);
    const results = await fetchAllQuotes({
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 10_000_000_000n,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      slippageBps: 10,
      allowAsync: false,
      venues: ["electric"],
    });
    expect(results).toHaveLength(1);
    const row = results[0]!;
    expect("quote" in row).toBe(true);
    if ("quote" in row) {
      expect(row.quote.venue).toBe("electric");
      expect(row.quote.amountOut).toBe("4000000000000000000");
    }
  });
});

describe("electric quote/build", () => {
  test("maps split legs and calldata", async () => {
    setErouterRunnerForTests(async (req) => {
      expect(req.tokenIn).toBe(USDC);
      expect(req.amountWei).toBe("10000000000");
      expect(req.slippageBps).toBe(10);
      return FIXTURE;
    });
    const q = await electricQuote({
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 10_000_000_000n,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      slippageBps: 10,
    });
    expect(q.venue).toBe("electric");
    expect(q.amountOut).toBe("4000000000000000000");
    expect(q.minAmountOut).toBe("3980000000000000000");
    expect(q.router?.toLowerCase()).toBe(ROUTER);
    expect(q.hops).toHaveLength(3);
    expect(q.hops[0]?.exchange).toBe("Curve 3pool");
    expect(q.hops.filter((h) => h.tokenIn === USDC)).toHaveLength(2);
    expect(q.gasUnits).toBeGreaterThan(0);

    const tx = await buildTx("electric", {
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      amountIn: 10_000_000_000n,
      sender: SENDER,
      slippageBps: 10,
      quote: q,
    });
    expect(tx.to.toLowerCase()).toBe(ROUTER);
    expect(tx.spender.toLowerCase()).toBe(ROUTER);
    expect(tx.data).toBe("0xabcdef");
    expect(tx.value).toBe("0");
    expect(tx.from).toBe(SENDER);
  });

  test("native in sets msg.value", async () => {
    setErouterRunnerForTests(async () => ({
      ...FIXTURE,
      call: { ...FIXTURE.call, token_in: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    }));
    const q = await electricQuote({
      chain: eth,
      tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      tokenOut: USDC,
      amountIn: 10n ** 18n,
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
      slippageBps: 10,
    });
    const tx = await buildTx("electric", {
      chain: eth,
      tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      tokenOut: USDC,
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
      amountIn: 10n ** 18n,
      sender: SENDER,
      slippageBps: 10,
      quote: q,
    });
    expect(tx.value).toBe((10n ** 18n).toString());
  });

  test("mainnet only", async () => {
    setErouterRunnerForTests(async () => FIXTURE);
    await expect(
      electricQuote({
        chain: base,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: 1n,
        tokenInDecimals: 6,
        tokenOutDecimals: 18,
        slippageBps: 10,
      }),
    ).rejects.toBeInstanceOf(UnsupportedChainError);
  });

  test("missing erouter is a loud error", async () => {
    const prev = process.env.EROUTER_BIN;
    process.env.EROUTER_BIN = "/tmp/erouter-does-not-exist";
    try {
      await expect(
        electricQuote({
          chain: eth,
          tokenIn: USDC,
          tokenOut: WETH,
          amountIn: 1n,
          tokenInDecimals: 6,
          tokenOutDecimals: 18,
          slippageBps: 10,
        }),
      ).rejects.toThrow(/erouter not found|EROUTER_BIN not found/);
    } finally {
      if (prev === undefined) delete process.env.EROUTER_BIN;
      else process.env.EROUTER_BIN = prev;
    }
  });

  test("build without call fails loud", async () => {
    const quote: NormalizedQuote = {
      venue: "electric",
      amountIn: "1",
      amountOut: "1",
      amountInUsd: null,
      amountOutUsd: null,
      gasUnits: null,
      gasPriceWei: null,
      gasUsd: null,
      router: ROUTER,
      hops: [],
      tokenHints: new Map(),
      raw: {},
    };
    await expect(
      buildTx("electric", {
        chain: eth,
        tokenIn: USDC,
        tokenOut: WETH,
        tokenInDecimals: 6,
        tokenOutDecimals: 18,
        amountIn: 1n,
        sender: SENDER,
        slippageBps: 10,
        quote,
      }),
    ).rejects.toThrow(/quote.raw.call missing/);
  });

  test("fetchQuote dispatches to electric", async () => {
    setErouterRunnerForTests(async () => FIXTURE);
    const q = await fetchQuote({
      venue: "electric",
      chain: eth,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 10_000_000_000n,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      slippageBps: 10,
    });
    expect(q.venue).toBe("electric");
    expect(q.amountOut).toBe("4000000000000000000");
  });
});

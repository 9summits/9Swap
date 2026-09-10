import { afterEach, describe, expect, test } from "bun:test";
import { GROSS, rankAmount, toRankQuote } from "../shared/rank.ts";
import { resolveChain } from "../src/chains.ts";
import {
  fusionMinAmountOut,
  fusionSlippagePercent,
  quote as fusionQuote,
} from "../src/venues/fusion.ts";
import { pickBest, type VenueResult } from "../src/venues/index.ts";
import type { NormalizedQuote, Venue } from "../src/venues/types.ts";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const eth = resolveChain("eth");

process.env.ONEINCH_API_KEY ||= "test-key";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fusionSlippagePercent", () => {
  test("bps → percent (same unit as classic 1inch)", () => {
    expect(fusionSlippagePercent(2)).toBe(0.02);
    expect(fusionSlippagePercent(10)).toBe(0.1);
    expect(fusionSlippagePercent(0)).toBe(0);
  });

  test("rejects unusable values", () => {
    expect(fusionSlippagePercent(Number.NaN)).toBeUndefined();
    expect(fusionSlippagePercent(-1)).toBeUndefined();
  });
});

describe("fusionMinAmountOut", () => {
  const presets = {
    fast: { auctionEndAmount: "16808700000" },
    medium: { auctionEndAmount: "16700000000" },
    slow: { auctionEndAmount: "16500000000" },
  };

  test("uses recommended preset auctionEnd when strictly below the cote", () => {
    expect(
      fusionMinAmountOut(
        { presets, recommended_preset: "fast" },
        "17336000000",
      ),
    ).toBe("16808700000");
  });

  test("camelCase recommendedPreset", () => {
    expect(
      fusionMinAmountOut({ presets, recommendedPreset: "medium" }, "17336000000"),
    ).toBe("16700000000");
  });

  test("omits when end >= cote (rank on amountOut)", () => {
    expect(
      fusionMinAmountOut(
        { presets: { fast: { auctionEndAmount: "17336000000" } }, recommended_preset: "fast" },
        "17336000000",
      ),
    ).toBeUndefined();
    expect(
      fusionMinAmountOut(
        { presets: { fast: { auctionEndAmount: "18000000000" } }, recommended_preset: "fast" },
        "17336000000",
      ),
    ).toBeUndefined();
  });

  test("falls back to fast when recommended is missing", () => {
    expect(fusionMinAmountOut({ presets }, "17336000000")).toBe("16808700000");
  });
});

describe("fusion quote wire", () => {
  async function quoteWith(body: unknown, slippageBps?: number) {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const q = await fusionQuote({
      chain: eth,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: 10n ** 18n,
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
      ...(slippageBps !== undefined ? { slippageBps } : {}),
    });
    return { q, url: new URL(capturedUrl) };
  }

  test("sends slippage as percent", async () => {
    const { url } = await quoteWith(
      { fromTokenAmount: "1000000000000000000", toTokenAmount: "3500000000" },
      2,
    );
    expect(url.searchParams.get("slippage")).toBe("0.02");
  });

  test("omits slippage when the caller did not pass bps", async () => {
    const { url } = await quoteWith({
      fromTokenAmount: "1000000000000000000",
      toTokenAmount: "3500000000",
    });
    expect(url.searchParams.get("slippage")).toBeNull();
  });

  test("sets minAmountOut from recommended auctionEndAmount", async () => {
    const { q } = await quoteWith({
      fromTokenAmount: "1000000000000000000",
      toTokenAmount: "3500000000",
      recommended_preset: "fast",
      presets: {
        fast: { auctionEndAmount: "3400000000" },
      },
    });
    expect(q.amountOut).toBe("3500000000");
    expect(q.minAmountOut).toBe("3400000000");
  });
});

function nq(
  venue: Venue,
  amountOut: string,
  extra?: Partial<NormalizedQuote>,
): NormalizedQuote {
  return {
    venue,
    amountIn: "1000",
    amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: null,
    hops: [],
    tokenHints: new Map(),
    raw: null,
    ...extra,
  };
}

function row(venue: Venue, amountOut: string, extra?: Partial<NormalizedQuote>): VenueResult {
  return { venue, quote: nq(venue, amountOut, extra) };
}

describe("pickBest ranks Fusion on minAmountOut", () => {
  test("optimistic cote loses to a lower guaranteed floor", () => {
    const { best } = pickBest(
      [
        row("fusion", "17400000", { minAmountOut: "16800000" }),
        row("kyber", "17300000"),
      ],
      "sell",
      GROSS,
    );
    expect(best?.venue).toBe("kyber");
  });

  test("wins when the floor still beats the field", () => {
    const { best } = pickBest(
      [
        row("fusion", "17500000", { minAmountOut: "17350000" }),
        row("kyber", "17300000"),
      ],
      "sell",
      GROSS,
    );
    expect(best?.venue).toBe("fusion");
  });

  test("toRankQuote / rankAmount use the floor", () => {
    const q = nq("fusion", "17400000", { minAmountOut: "16800000" });
    const rq = toRankQuote(q, true);
    expect(rq.minAmountOut).toBe("16800000");
    expect(rankAmount(rq, "sell", GROSS)).toBe("16800000");
  });
});

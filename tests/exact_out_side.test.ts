import { describe, expect, test } from "bun:test";
import {
  assertQuoteAmount,
  parseWireQuoteAmounts,
  type TradeSide,
} from "../src/trade_side.ts";
import { GROSS, sortRoutesBySide } from "../shared/rank.ts";
import { maxAmountIn, minAmountOut } from "../src/slippage.ts";
import { pickBest, type VenueResult } from "../src/venues/index.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

function q(
  venue: NormalizedQuote["venue"],
  amountIn: string,
  amountOut: string,
): VenueResult {
  return {
    venue,
    quote: {
      venue,
      amountIn,
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
    },
  };
}

describe("parseWireQuoteAmounts (XOR wire contract)", () => {
  test("infers sell from amountIn only", () => {
    expect(parseWireQuoteAmounts({ amountIn: "1" })).toEqual({
      side: "sell",
      amountIn: 1n,
      amountOut: undefined,
    });
  });

  test("infers buy from amountOut only", () => {
    expect(parseWireQuoteAmounts({ amountOut: "2" })).toEqual({
      side: "buy",
      amountIn: undefined,
      amountOut: 2n,
    });
  });

  test("rejects both amounts", () => {
    expect(() =>
      parseWireQuoteAmounts({ amountIn: "1", amountOut: "2" }),
    ).toThrow(/exactly one of amountIn or amountOut/);
  });

  test("rejects neither amount", () => {
    expect(() => parseWireQuoteAmounts({})).toThrow(
      /missing amountIn or amountOut/,
    );
  });

  test("rejects side=sell with only amountOut", () => {
    expect(() =>
      parseWireQuoteAmounts({ amountOut: "1", side: "sell" }),
    ).toThrow(/sell.*amountIn|amountIn.*sell/i);
  });

  test("rejects side=buy with only amountIn", () => {
    expect(() =>
      parseWireQuoteAmounts({ amountIn: "1", side: "buy" }),
    ).toThrow(/buy.*amountOut|amountOut.*buy/i);
  });

  test("accepts explicit side matching the amount", () => {
    expect(parseWireQuoteAmounts({ amountIn: "9", side: "sell" }).side).toBe(
      "sell",
    );
    expect(parseWireQuoteAmounts({ amountOut: "9", side: "buy" }).side).toBe(
      "buy",
    );
  });
});

describe("sortRoutesBySide sinks non-positive", () => {
  test("buy: amountIn=0 sinks below real quotes", () => {
    const routes = [
      { venue: "zero", amountIn: "0", amountOut: "100", execution: { kind: "async" as const } },
      { venue: "cheap", amountIn: "80", amountOut: "100", execution: { kind: "async" as const } },
      { venue: "dear", amountIn: "200", amountOut: "100", execution: { kind: "async" as const } },
    ];
    const sorted = sortRoutesBySide(routes, "buy", GROSS);
    expect(sorted.map((r) => r.venue)).toEqual(["cheap", "dear", "zero"]);
  });

  test("sell: amountOut=0 sinks below real quotes", () => {
    const routes = [
      { venue: "zero", amountIn: "100", amountOut: "0", execution: { kind: "async" as const } },
      { venue: "best", amountIn: "100", amountOut: "50", execution: { kind: "async" as const } },
      { venue: "mid", amountIn: "100", amountOut: "20", execution: { kind: "async" as const } },
    ];
    const sorted = sortRoutesBySide(routes, "sell", GROSS);
    expect(sorted.map((r) => r.venue)).toEqual(["best", "mid", "zero"]);
  });
});

describe("assertQuoteAmount", () => {
  test("sell requires amountIn", () => {
    expect(() =>
      assertQuoteAmount({ side: "sell", amountOut: 1n }),
    ).toThrow(/amountIn/);
    expect(() =>
      assertQuoteAmount({ side: "sell", amountIn: 1n }),
    ).not.toThrow();
  });

  test("buy requires amountOut", () => {
    expect(() =>
      assertQuoteAmount({ side: "buy", amountIn: 1n }),
    ).toThrow(/amountOut/);
    expect(() =>
      assertQuoteAmount({ side: "buy", amountOut: 1n }),
    ).not.toThrow();
  });
});

describe("slippage helpers", () => {
  test("minAmountOut shrinks by bps", () => {
    // 1% of 10_000 = 100 → min = 9900
    expect(minAmountOut(10_000n, 100)).toBe(9900n);
    expect(minAmountOut(10_000n, 0)).toBe(10_000n);
    expect(minAmountOut(10_000n, 10_000)).toBe(0n);
  });

  test("maxAmountIn expands by bps", () => {
    // 1% of 10_000 = 100 → max = 10_100
    expect(maxAmountIn(10_000n, 100)).toBe(10_100n);
    expect(maxAmountIn(10_000n, 0)).toBe(10_000n);
    // 50 bps of 1e18
    expect(maxAmountIn(10n ** 18n, 50)).toBe(
      10n ** 18n + (10n ** 18n * 50n) / 10_000n,
    );
  });
});

describe("pickBest by side", () => {
  const results: VenueResult[] = [
    q("kyber", "1000", "50"),
    q("odos", "900", "55"),
    q("velora", "800", "40"),
    { venue: "matcha", error: "boom" },
  ];

  test("sell: maximizes amountOut", () => {
    const { best } = pickBest(results, "sell", GROSS);
    expect(best?.venue).toBe("odos");
    expect(best?.quote.amountOut).toBe("55");
  });

  test("buy: minimizes amountIn (ignore errors / zero)", () => {
    const withZero: VenueResult[] = [
      ...results,
      q("1inch", "0", "55"),
    ];
    const { best } = pickBest(withZero, "buy", GROSS);
    expect(best?.venue).toBe("velora");
    expect(best?.quote.amountIn).toBe("800");
  });

  test("sell ranking when side is sell", () => {
    const { best } = pickBest(results, "sell", GROSS);
    expect(best?.venue).toBe("odos");
  });

  test("returns null when no successful quotes", () => {
    const { best } = pickBest([{ venue: "kyber", error: "x" }], "buy", GROSS);
    expect(best).toBeNull();
  });
});

// Compile-time smoke: TradeSide is the union we expect.
const _side: TradeSide = "sell";
void _side;

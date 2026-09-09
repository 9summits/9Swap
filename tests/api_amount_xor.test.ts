import { afterAll, describe, expect, test, mock } from "bun:test";
import {
  parseWireQuoteAmounts,
  type TradeSide,
} from "../src/trade_side.ts";
import { GROSS, sortRoutesBySide } from "../shared/rank.ts";
import { pickBest, type VenueResult } from "../src/venues/index.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

const realCore = { ...(await import("../src/core.ts")) };
afterAll(() => {
  mock.module("../src/core.ts", () => realCore);
});

describe("parseWireQuoteAmounts", () => {
  test("amountIn alone infers sell", () => {
    expect(parseWireQuoteAmounts({ amountIn: "1000" })).toEqual({
      side: "sell",
      amountIn: 1000n,
      amountOut: undefined,
    });
  });

  test("amountOut alone infers buy", () => {
    expect(parseWireQuoteAmounts({ amountOut: "500" })).toEqual({
      side: "buy",
      amountIn: undefined,
      amountOut: 500n,
    });
  });

  test("both missing → error", () => {
    expect(() => parseWireQuoteAmounts({})).toThrow("missing amountIn or amountOut");
    expect(() => parseWireQuoteAmounts({ amountIn: "", amountOut: "" })).toThrow(
      "missing amountIn or amountOut",
    );
  });

  test("both present → error", () => {
    expect(() => parseWireQuoteAmounts({ amountIn: "1", amountOut: "2" })).toThrow(
      "provide exactly one of amountIn or amountOut",
    );
  });

  test("side=sell with only amountOut → error", () => {
    expect(() => parseWireQuoteAmounts({ amountOut: "1", side: "sell" })).toThrow(
      "side=sell requires amountIn",
    );
  });

  test("side=buy with only amountIn → error", () => {
    expect(() => parseWireQuoteAmounts({ amountIn: "1", side: "buy" })).toThrow(
      "side=buy requires amountOut",
    );
  });

  test("explicit side matching the present amount is accepted", () => {
    expect(parseWireQuoteAmounts({ amountIn: "9", side: "sell" }).side).toBe("sell");
    expect(parseWireQuoteAmounts({ amountOut: "9", side: "buy" }).side).toBe("buy");
  });

  test("invalid side rejected", () => {
    expect(() => parseWireQuoteAmounts({ amountIn: "1", side: "swap" })).toThrow(
      "invalid side",
    );
  });

  test("non-integer / negative amounts rejected", () => {
    expect(() => parseWireQuoteAmounts({ amountIn: "1.5" })).toThrow(/invalid 'amountIn'/);
    expect(() => parseWireQuoteAmounts({ amountOut: "-1" })).toThrow(/non-negative/);
  });
});

describe("sortRoutesBySide", () => {
  const routes = [
    { venue: "a", amountIn: "300", amountOut: "10", execution: { kind: "async" as const } },
    { venue: "b", amountIn: "100", amountOut: "50", execution: { kind: "async" as const } },
    { venue: "c", amountIn: "200", amountOut: "20", execution: { kind: "async" as const } },
  ];

  test("sell ranks by amountOut desc", () => {
    const sorted = sortRoutesBySide(routes, "sell" as TradeSide, GROSS);
    expect(sorted.map((r) => r.venue)).toEqual(["b", "c", "a"]);
  });

  test("buy ranks by amountIn asc", () => {
    const sorted = sortRoutesBySide(routes, "buy" as TradeSide, GROSS);
    expect(sorted.map((r) => r.venue)).toEqual(["b", "c", "a"]);
  });
});

function fakeQuote(venue: NormalizedQuote["venue"], amountIn: string, amountOut: string): VenueResult {
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

describe("pickBest by side", () => {
  const results: VenueResult[] = [
    fakeQuote("kyber", "300", "10"),
    fakeQuote("velora", "100", "50"),
    fakeQuote("odos", "200", "20"),
  ];

  test("sell maximizes amountOut", () => {
    expect(pickBest(results, "sell", GROSS).best?.venue).toBe("velora");
  });

  test("buy minimizes amountIn", () => {
    expect(pickBest(results, "buy", GROSS).best?.venue).toBe("velora");
  });
});

describe("handleQuote XOR validation (HTTP 400)", () => {
  test("both missing / both present / buy reaches quote layer with side=buy", async () => {
    const quoteAllCalls: Array<Record<string, unknown>> = [];

    mock.module("../src/core.ts", () => ({
      resolveTokenPair: async () => ({
        chain: {
          chainId: 1,
          alias: "eth",
          displayName: "Ethereum",
          explorer: "https://etherscan.io",
          nativeSymbol: "ETH",
        },
        tokenIn: {
          address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          symbol: "ETH",
          decimals: 18,
          name: "ETH",
          chainId: 1,
          source: "wire",
        },
        tokenOut: {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          symbol: "USDC",
          decimals: 6,
          name: "USDC",
          chainId: 1,
          source: "wire",
        },
      }),
      quoteAll: async (p: Record<string, unknown>) => {
        quoteAllCalls.push(p);
        return {
          best: {
            venue: "velora",
            quote: {
              venue: "velora",
              amountIn: p.side === "buy" ? "999" : String(p.amountIn),
              amountOut: p.side === "buy" ? String(p.amountOut) : "1000",
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
          },
          results: [
            {
              venue: "velora",
              quote: {
                venue: "velora",
                amountIn: p.side === "buy" ? "999" : String(p.amountIn),
                amountOut: p.side === "buy" ? String(p.amountOut) : "1000",
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
            },
          ],
        };
      },
      quoteAllStream: async function* () {},
      quoteSingle: async () => {
        throw new Error("not used");
      },
      resolveOneToken: async () => {
        throw new Error("not used");
      },
      tokenList: async () => [],
      buildForVenue: async () => {
        throw new Error("not used");
      },
      checkAllowance: async () => {
        throw new Error("not used");
      },
      needsAllowanceCheck: () => false,
      assemble: async () => {
        throw new Error("not used");
      },
      resolveRouteHops: async () => [],
      listChains: () => [],
      listVenues: () => [],
    }));

    // Re-import after mock so handleQuote binds the stubbed core.
    const { handleQuote } = await import(`../src/server/handlers.ts?t=${Date.now()}`);

    const base = {
      chain: "eth",
      tokenInAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      tokenOutAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      slippageBps: 10,
    };

    const missing = await handleQuote(
      new Request("http://local/api/quote", {
        method: "POST",
        body: JSON.stringify(base),
      }),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "missing amountIn or amountOut" });

    const both = await handleQuote(
      new Request("http://local/api/quote", {
        method: "POST",
        body: JSON.stringify({ ...base, amountIn: "1", amountOut: "2" }),
      }),
    );
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({
      error: "provide exactly one of amountIn or amountOut",
    });

    quoteAllCalls.length = 0;
    const buy = await handleQuote(
      new Request("http://local/api/quote", {
        method: "POST",
        body: JSON.stringify({ ...base, amountOut: "1000000" }),
      }),
    );
    expect(buy.status).toBe(200);
    const buyBody = await buy.json();
    expect(buyBody.side).toBe("buy");
    expect(buyBody.routes[0].amountIn).toBeDefined();
    expect(quoteAllCalls.length).toBe(1);
    expect(quoteAllCalls[0]!.side).toBe("buy");
    expect(quoteAllCalls[0]!.amountOut).toBe(1000000n);

    quoteAllCalls.length = 0;
    const sell = await handleQuote(
      new Request("http://local/api/quote", {
        method: "POST",
        body: JSON.stringify({ ...base, amountIn: "1000000000000000000" }),
      }),
    );
    expect(sell.status).toBe(200);
    const sellBody = await sell.json();
    expect(sellBody.side).toBe("sell");
    expect(sellBody.amountIn).toBe("1000000000000000000");
    expect(sellBody.routes[0].amountIn).toBeDefined();
    expect(quoteAllCalls[0]!.side).toBe("sell");
    expect(quoteAllCalls[0]!.amountIn).toBe(1000000000000000000n);
  });
});

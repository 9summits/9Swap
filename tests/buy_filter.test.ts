import { afterAll, describe, expect, test, mock } from "bun:test";
import { resolveChain } from "../src/chains.ts";
import {
  availableVenues,
  skippedVenues,
  fetchQuote,
  fetchAllQuotes,
  UnsupportedSideError,
} from "../src/venues/index.ts";
import { BUY_CAPABLE_VENUES, isBuyCapable } from "../src/trade_side.ts";

const realCore = { ...(await import("../src/core.ts")) };
afterAll(() => {
  mock.module("../src/core.ts", () => realCore);
});

// PR6 — exact-out (side="buy") only lets BUY_CAPABLE_VENUES race. Sell-only
// venues are dropped in the multi-venue paths (surfaced in the comparison) and
// hard-error when picked explicitly. Everything below is network-free: the
// filtering / defense-in-depth throws fire before any adapter fetch.

const CHAIN = resolveChain("eth");
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

describe("availableVenues by side", () => {
  test("buy keeps only buy-capable venues", () => {
    const buy = availableVenues({ allowAsync: true, side: "buy" });
    // Every survivor is buy-capable — never a sell-only venue.
    expect(buy.every(isBuyCapable)).toBe(true);
    // velora and cow have no API-key gate, so they're deterministically ready
    // (cow only with allowAsync, being async).
    expect(buy).toContain("velora");
    expect(buy).toContain("cow");
    // Sell-only venues never appear regardless of keys.
    expect(buy).not.toContain("kyber");
    expect(buy).not.toContain("odos");
    expect(buy).not.toContain("1inch");
    expect(buy).not.toContain("delta");
    expect(buy).not.toContain("uniswapx");
  });

  test("buy without allowAsync drops async buy-capable venues (cow/ophis)", () => {
    const buy = availableVenues({ allowAsync: false, side: "buy" });
    expect(buy).toContain("velora"); // sync, keyless
    expect(buy).not.toContain("cow"); // async — needs --allow-async
    expect(buy).not.toContain("ophis"); // async
  });

  test("sell (default) keeps sell-only venues", () => {
    const sell = availableVenues({ allowAsync: true, side: "sell" });
    expect(sell).toContain("kyber");
    // odos / odosv2 are discontinued (2026-07-30) — never available on any side.
    expect(sell).not.toContain("odos");
    expect(sell).not.toContain("odosv2");
    // Default side omitted behaves like sell.
    expect(availableVenues({ allowAsync: true })).toContain("kyber");
  });
});

describe("skippedVenues by side", () => {
  test("buy reports sell-only venues with the distinct 'sell-only' reason", () => {
    const skips = skippedVenues({ allowAsync: true, side: "buy" });
    const byVenue = new Map(skips.map((s) => [s.venue, s]));
    // kyber / curve have no env-var gate, so their only skip reason is sell-only.
    expect(byVenue.get("kyber")?.reason).toBe("sell-only");
    expect(byVenue.get("curve")?.reason).toBe("sell-only");
    // A buy-capable, keyless venue is NOT skipped.
    expect(byVenue.has("velora")).toBe(false);
    // A discontinued venue is absent entirely, not "skipped" (2026-07-30).
    expect(byVenue.has("odos")).toBe(false);
  });

  test("sell never reports a sell-only reason", () => {
    const skips = skippedVenues({ allowAsync: true, side: "sell" });
    expect(skips.some((s) => s.reason === "sell-only")).toBe(false);
  });
});

describe("fetchQuote defense-in-depth", () => {
  test("buy + sell-only venue throws UnsupportedSideError before any network call", async () => {
    await expect(
      fetchQuote({
        venue: "kyber",
        chain: CHAIN,
        tokenIn: USDC,
        tokenOut: NATIVE,
        tokenInDecimals: 6,
        tokenOutDecimals: 18,
        slippageBps: 10,
        side: "buy",
        amountOut: 1_000_000n,
      }),
    ).rejects.toThrow(UnsupportedSideError);
  });

  test("the error message names the buy-capable set", async () => {
    try {
      await fetchQuote({
        venue: "curve",
        chain: CHAIN,
        tokenIn: USDC,
        tokenOut: NATIVE,
        tokenInDecimals: 6,
        tokenOutDecimals: 18,
        slippageBps: 10,
        side: "buy",
        amountOut: 1_000_000n,
      });
      throw new Error("expected UnsupportedSideError");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/does not support exact-out|sell-only/i);
      // Lists the buy-capable venues so the user knows what to switch to.
      expect(msg).toContain(BUY_CAPABLE_VENUES[0]!);
    }
  });
});

describe("fetchAllQuotes venue-list filtering", () => {
  test("buy + an all-sell-only comma-list resolves to zero venues (no fetch)", async () => {
    // resolveVenueList intersects the requested list with availableVenues(buy);
    // kyber+curve are both sell-only, so the intersection is empty and no
    // adapter is ever called — the result is [] with no network.
    const results = await fetchAllQuotes({
      chain: CHAIN,
      tokenIn: USDC,
      tokenOut: NATIVE,
      tokenInDecimals: 6,
      tokenOutDecimals: 18,
      slippageBps: 10,
      side: "buy",
      amountOut: 1_000_000n,
      allowAsync: false,
      venues: ["kyber", "curve"],
    });
    expect(results).toEqual([]);
  });
});

describe("handlers reject sell-only venues on exact-out (HTTP 400)", () => {
  test("/api/route and /api/build → 400; buy-capable + sell paths pass the gate", async () => {
    // Stub core: sell-only + buy must 400 BEFORE quoteSingle (gate). Controls
    // that pass the gate get a minimal quote so the handler returns 200 without
    // console.error noise ("/api/route failed: not used").
    let quoteSingleCalls = 0;
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
      quoteSingle: async (p: { venue: string; amountIn?: bigint; amountOut?: bigint }) => {
        quoteSingleCalls++;
        return {
          venue: p.venue,
          amountIn: String(p.amountIn ?? 1n),
          amountOut: String(p.amountOut ?? 1n),
          amountInUsd: null,
          amountOutUsd: null,
          gasUnits: null,
          gasPriceWei: null,
          gasUsd: null,
          router: null,
          hops: [],
          tokenHints: new Map(),
          raw: null,
        };
      },
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

    const { handleRoute, handleBuild } = await import(
      `../src/server/handlers.ts?t=${Date.now()}`
    );

    const tokenIn = { address: USDC, symbol: "USDC", decimals: 6 };
    const tokenOut = { address: NATIVE, symbol: "ETH", decimals: 18 };
    const routeReq = (venue: string, amount: { amountIn?: string; amountOut?: string }) =>
      new Request("http://local/api/route", {
        method: "POST",
        body: JSON.stringify({ chain: "eth", venue, tokenIn, tokenOut, ...amount }),
      });
    const buildReq = (venue: string, amount: { amountIn?: string; amountOut?: string }) =>
      new Request("http://local/api/build", {
        method: "POST",
        body: JSON.stringify({
          chain: "eth",
          venue,
          sender: "0x1111111111111111111111111111111111111111",
          tokenIn,
          tokenOut,
          ...amount,
        }),
      });

    // Sell-only venue + exact-out → explicit 400 on both endpoints (no quote).
    const beforeGate = quoteSingleCalls;
    const routeBuy = await handleRoute(routeReq("kyber", { amountOut: "1000000" }));
    expect(routeBuy.status).toBe(400);
    expect((await routeBuy.json()).error).toMatch(/exact-out|sell-only/i);

    const buildBuy = await handleBuild(buildReq("kyber", { amountOut: "1000000" }));
    expect(buildBuy.status).toBe(400);
    expect((await buildBuy.json()).error).toMatch(/exact-out|sell-only/i);
    expect(quoteSingleCalls).toBe(beforeGate); // gate fired before quoteSingle

    // Control 1: buy-capable venue passes the gate → stubbed quote → 200.
    const routeVelora = await handleRoute(routeReq("velora", { amountOut: "1000000" }));
    expect(routeVelora.status).toBe(200);
    expect((await routeVelora.json()).venue).toBe("velora");

    // Control 2: sell-only venue on SELL is not blocked → stubbed quote → 200.
    const routeSell = await handleRoute(routeReq("kyber", { amountIn: "1000000" }));
    expect(routeSell.status).toBe(200);
    expect(quoteSingleCalls).toBe(beforeGate + 2);
  });
});

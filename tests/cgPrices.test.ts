import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { fetchPairRate, fetchUsdPrices, __cgTest } from "../web/src/dapp/cgPrices";

// Mainnet stablecoins present in CG_IDS[1] (both resolve to a coin id).
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // usd-coin
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // tether
// Two addresses NOT in CG_IDS[1].byAddr → force the token_price contract fallback.
const UNK_A = "0x00000000000000000000000000000000000000aa";
const UNK_B = "0x00000000000000000000000000000000000000bb";

const realFetch = globalThis.fetch;
// Each test installs a handler; `calls` records every requested URL.
let handler: (url: string) => Response;
let calls: string[];

beforeEach(() => {
  __cgTest.reset();
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("cgPrices.fetchUsdPrices", () => {
  test("keys the map by input addr; native sentinel stays 0xeee", async () => {
    const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    handler = (url) => {
      expect(url).toContain("/simple/price?ids=");
      expect(url).toContain("ethereum");
      expect(url).toContain("usd-coin");
      return json({ ethereum: { usd: 3000 }, "usd-coin": { usd: 1 } });
    };
    const prices = await fetchUsdPrices(1, [NATIVE, USDC]);
    expect(prices.get(NATIVE)).toBe(3000);
    expect(prices.get(USDC)).toBe(1);
    expect([...prices.keys()]).toEqual([NATIVE, USDC]);
    expect(calls.length).toBe(1);
  });
});

describe("cgPrices.fetchPairRate", () => {
  test("id path: both sides priced in ONE batched simple/price call", async () => {
    handler = (url) => {
      expect(url).toContain("/simple/price?ids=");
      expect(url).toContain("usd-coin");
      expect(url).toContain("tether");
      return json({ "usd-coin": { usd: 2 }, tether: { usd: 1 } });
    };
    // pin=2 (USDC), pout=1 (USDT) → rate 2.
    const rate = await fetchPairRate(1, USDC, USDT);
    expect(rate).toBe(2);
    // A single batched request covered both sides.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/simple/price?ids=");
  });

  test("contract fallback: id-less tokens use per-contract token_price", async () => {
    handler = (url) => {
      expect(url).toContain("/simple/token_price/ethereum");
      const addr = new URL(url).searchParams
        .get("contract_addresses")!
        .toLowerCase();
      const usd = addr === UNK_A ? 4 : 2;
      return json({ [addr]: { usd } });
    };
    // pin=4, pout=2 → rate 2. No id batch (neither has an id); one call per token.
    const rate = await fetchPairRate(1, UNK_A, UNK_B);
    expect(rate).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls.every((u) => u.includes("/simple/token_price/"))).toBe(true);
  });

  test("stale-on-error: a failed refresh serves a ≤10-min-old price", async () => {
    // Seed both sides stale (6 min old: past the 5-min fresh window, inside 10 min).
    __cgTest.seed(__cgTest.resolveToken(1, USDC).key, 4, 6 * 60_000);
    __cgTest.seed(__cgTest.resolveToken(1, USDT).key, 2, 6 * 60_000);
    handler = () => {
      throw new Error("network down");
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    // Both stale values served → 4 / 2 = 2, despite the fetch throwing.
    expect(rate).toBe(2);
    expect(calls.length).toBe(1); // one (failed) batch attempt
  });

  test("stale ceiling: a >10-min-old price is NOT served on error", async () => {
    // Past the stale window (11 min): a wrong mid could mis-gate the -10%
    // confirm popup, so the rate must drop to null instead.
    __cgTest.seed(__cgTest.resolveToken(1, USDC).key, 4, 11 * 60_000);
    __cgTest.seed(__cgTest.resolveToken(1, USDT).key, 2, 11 * 60_000);
    handler = () => {
      throw new Error("network down");
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    expect(rate).toBeNull();
  });

  test("negative cache: a no-price result is cached and not re-fetched", async () => {
    // usd-coin priced, tether absent → pout null → pair rate null.
    handler = () => json({ "usd-coin": { usd: 1 } });
    const first = await fetchPairRate(1, USDC, USDT);
    expect(first).toBeNull();
    expect(calls.length).toBe(1);

    // Second call within the 2-min negative window: no new network request.
    const second = await fetchPairRate(1, USDC, USDT);
    expect(second).toBeNull();
    expect(calls.length).toBe(1);
  });

  test("429: one retry honoring Retry-After, then stale-on-error", async () => {
    __cgTest.seed(__cgTest.resolveToken(1, USDC).key, 10, 6 * 60_000);
    __cgTest.seed(__cgTest.resolveToken(1, USDT).key, 5, 6 * 60_000);
    let n = 0;
    handler = () => {
      n++;
      return json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "0" } });
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    // 10 / 5 = 2 from the stale cache after the retry also 429s.
    expect(rate).toBe(2);
    expect(n).toBe(2); // initial + one retry
  });
});

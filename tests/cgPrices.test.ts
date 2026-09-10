import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { fetchPairRate, fetchUsdPrices, __cgTest } from "../web/src/dapp/cgPrices";

// Mainnet stablecoins present in CG_IDS[1] (both resolve to a coin id).
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // usd-coin
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // tether
// Two addresses NOT in CG_IDS[1].byAddr → force the token_price contract fallback.
const UNK_A = "0x00000000000000000000000000000000000000aa";
const UNK_B = "0x00000000000000000000000000000000000000bb";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
// Each test installs a handler; `calls` records every requested URL.
let handler: (url: string) => Response;
let calls: string[];
let warns: unknown[][];

beforeEach(() => {
  __cgTest.reset();
  calls = [];
  warns = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  // Regression: passing an Error as a console.warn argument dumps a stack
  // into the CLI (the original 429-spam). Every path must log strings only.
  for (const args of warns) {
    expect(args.some((a) => a instanceof Error)).toBe(false);
  }
});

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const rateLimited = () =>
  json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "0" } });

const cgCalls = () => calls.filter((u) => u.includes("api.coingecko.com"));
const llamaCalls = () => calls.filter((u) => u.includes("coins.llama.fi"));

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
    expect(llamaCalls().length).toBe(0);
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
    expect(llamaCalls().length).toBe(0);
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
    expect(llamaCalls().length).toBe(0);
  });

  test("stale-on-error: a failed refresh serves a ≤10-min-old price", async () => {
    // Seed both sides stale (6 min old: past the 5-min fresh window, inside 10 min).
    __cgTest.seed(__cgTest.resolveToken(1, USDC).key, 4, 6 * 60_000);
    __cgTest.seed(__cgTest.resolveToken(1, USDT).key, 2, 6 * 60_000);
    handler = () => {
      throw new Error("network down");
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    // Both stale values served → 4 / 2 = 2, despite CG and DefiLlama throwing.
    expect(rate).toBe(2);
    expect(cgCalls().length).toBe(1);
    expect(llamaCalls().length).toBe(1);
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

  test("429: no CoinGecko retry; DefiLlama fills the batch", async () => {
    handler = (url) => {
      if (url.includes("api.coingecko.com")) return rateLimited();
      if (url.includes("coins.llama.fi")) {
        expect(url).toContain("coingecko:usd-coin");
        expect(url).toContain("coingecko:tether");
        return json({
          coins: {
            "coingecko:usd-coin": { price: 2 },
            "coingecko:tether": { price: 1 },
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    expect(rate).toBe(2);
    expect(cgCalls().length).toBe(1); // no retry
    expect(llamaCalls().length).toBe(1);
    expect(__cgTest.cooldownRemainingMs()).toBeGreaterThan(0);
    expect(warns.length).toBe(1);
    expect(String(warns[0]![0])).toContain("using DefiLlama");
  });

  test("429 + DefiLlama miss: stale-on-error, one log, CoinGecko paused", async () => {
    __cgTest.seed(__cgTest.resolveToken(1, USDC).key, 10, 6 * 60_000);
    __cgTest.seed(__cgTest.resolveToken(1, USDT).key, 5, 6 * 60_000);
    handler = (url) => {
      if (url.includes("api.coingecko.com")) return rateLimited();
      if (url.includes("coins.llama.fi")) return rateLimited();
      throw new Error(`unexpected request: ${url}`);
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    expect(rate).toBe(2); // 10 / 5 from stale
    expect(cgCalls().length).toBe(1);
    expect(llamaCalls().length).toBe(1);
    expect(__cgTest.cooldownRemainingMs()).toBeGreaterThan(0);
    // One compact failure line + one "serving stale" line — not one per token.
    expect(warns.length).toBeLessThanOrEqual(2);
    expect(warns.every((a) => typeof a[0] === "string")).toBe(true);
  });

  test("absence: a thrown fetch falls through to DefiLlama", async () => {
    handler = (url) => {
      if (url.includes("api.coingecko.com")) throw new Error("fetch failed");
      if (url.includes("coins.llama.fi")) {
        return json({
          coins: {
            "coingecko:usd-coin": { price: 8 },
            "coingecko:tether": { price: 2 },
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const rate = await fetchPairRate(1, USDC, USDT);
    expect(rate).toBe(4);
    expect(cgCalls().length).toBe(1);
    expect(llamaCalls().length).toBe(1);
    expect(__cgTest.cooldownRemainingMs()).toBeGreaterThan(0);
  });

  test("cooldown: a later lookup skips CoinGecko entirely", async () => {
    handler = (url) => {
      if (url.includes("api.coingecko.com")) return rateLimited();
      if (url.includes("coins.llama.fi")) {
        return json({
          coins: {
            "coingecko:usd-coin": { price: 2 },
            "coingecko:tether": { price: 1 },
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    expect(await fetchPairRate(1, USDC, USDT)).toBe(2);
    expect(cgCalls().length).toBe(1);

    // Drop the 5-min positive cache so the second call would otherwise refetch.
    __cgTest.cache.clear();
    const mark = calls.length;
    expect(await fetchPairRate(1, USDC, USDT)).toBe(2);
    expect(cgCalls().length).toBe(1); // still the first one
    expect(calls.slice(mark).every((u) => u.includes("coins.llama.fi"))).toBe(true);
  });

  test("contract 429: DefiLlama prices by chain:address", async () => {
    handler = (url) => {
      if (url.includes("api.coingecko.com")) return rateLimited();
      if (url.includes("coins.llama.fi")) {
        const path = url.slice(url.lastIndexOf("/") + 1);
        const usd = path.includes(UNK_A) ? 4 : 2;
        return json({ coins: { [decodeURIComponent(path)]: { price: usd } } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const rate = await fetchPairRate(1, UNK_A, UNK_B);
    expect(rate).toBe(2);
    // Parallel token_price calls: both may hit CoinGecko before the first 429
    // arms the cooldown, or the second may skip it. Either way, no retry.
    expect(cgCalls().length).toBeGreaterThanOrEqual(1);
    expect(cgCalls().length).toBeLessThanOrEqual(2);
    expect(llamaCalls().length).toBe(2);
    expect(llamaCalls().every((u) => u.includes("ethereum:0x"))).toBe(true);
  });

  test("a 3-token id batch 429 logs once, not once per token", async () => {
    const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    handler = (url) => {
      if (url.includes("api.coingecko.com")) return rateLimited();
      if (url.includes("coins.llama.fi")) {
        return json({
          coins: {
            "coingecko:ethereum": { price: 3000 },
            "coingecko:usd-coin": { price: 1 },
            "coingecko:tether": { price: 1 },
          },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const prices = await fetchUsdPrices(1, [NATIVE, USDC, USDT]);
    expect(prices.get(NATIVE)).toBe(3000);
    expect(prices.get(USDC)).toBe(1);
    expect(cgCalls().length).toBe(1);
    expect(llamaCalls().length).toBe(1);
    expect(warns.length).toBe(1);
  });
});

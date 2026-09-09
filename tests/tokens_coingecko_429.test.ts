// CoinGecko 429 resilience in src/tokens.ts.
//
// The failure this pins down: a rate-limited CoinGecko used to make token
// resolution sleep 30-60s per call, fan out over up to 8 candidates while the
// API kept saying 429, and finally report a misleading "not found". On Vercel
// that is a killed function (opaque 500/504); in the CLI it is a frozen
// terminal. Now: one short capped retry, a typed CoinGeckoRateLimitError that
// stops the candidate loop, a module-level cooldown so nothing re-hits the API,
// and — on the address path only — a fall-through to on-chain decimals().
//
// Same globalThis.fetch mocking pattern as tests/cgPrices.test.ts; every case is
// offline. CoinGecko answers 429 with `retry-after: 0` so no test actually waits.

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  resolveToken,
  coinGeckoRetryDelayMs,
  coinGeckoCooldownMs,
  __cgTest,
} from "../src/tokens.ts";
import { resolveChain } from "../src/chains.ts";

const ETH = resolveChain("eth");
const UNKNOWN_TOKEN = `0x${"0".repeat(38)}aa`;

const realFetch = globalThis.fetch;
let handler: (url: string, init?: RequestInit) => Response;
let calls: string[];

beforeEach(() => {
  __cgTest.reset();
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __cgTest.reset();
});

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

/** CoinGecko's rate-limit answer. retry-after: 0 keeps the retry instant. */
const rateLimited = () =>
  json({ status: { error_code: 429 } }, { status: 429, headers: { "retry-after": "0" } });

/** ks-setting answering "no such token" so the chain falls through to CoinGecko. */
const kyberMiss = () => json({ data: { tokens: [] } });

const cgCalls = (from = 0) =>
  calls.slice(from).filter((u) => u.includes("api.coingecko.com"));

describe("tokens.ts — CoinGecko 429", () => {
  test("symbol path: a persistent 429 is reported as a rate limit, not 'not found'", async () => {
    handler = (url) => {
      if (url.includes("ks-setting.kyberswap.com")) return kyberMiss();
      if (url.includes("api.coingecko.com")) return rateLimited();
      throw new Error(`unexpected request: ${url}`);
    };

    const started = Date.now();
    await expect(resolveToken("FOOBAR", ETH)).rejects.toThrow(
      /rate limited \(HTTP 429\)/,
    );
    // No 30s sleep: with retry-after: 0 the whole thing is immediate.
    expect(Date.now() - started).toBeLessThan(2_000);

    // Exactly the /search call plus its single retry — no candidate fan-out.
    const cg = cgCalls();
    expect(cg.length).toBe(2);
    expect(cg.every((u) => u.includes("/api/v3/search?"))).toBe(true);
  });

  test("candidate loop stops at the first rate-limited /coins/{id}", async () => {
    handler = (url) => {
      if (url.includes("ks-setting.kyberswap.com")) return kyberMiss();
      if (url.includes("/api/v3/search?")) {
        return json({
          coins: [
            { id: "foo-a", symbol: "foobar", name: "Foo A" },
            { id: "foo-b", symbol: "foobar", name: "Foo B" },
            { id: "foo-c", symbol: "foobar", name: "Foo C" },
          ],
        });
      }
      if (url.includes("/api/v3/coins/")) return rateLimited();
      throw new Error(`unexpected request: ${url}`);
    };

    await expect(resolveToken("FOOBAR", ETH)).rejects.toThrow(
      /rate limited \(HTTP 429\)/,
    );

    const details = calls.filter((u) => u.includes("/api/v3/coins/"));
    // First candidate only: initial + one retry. foo-b / foo-c never queried.
    expect(details.length).toBe(2);
    expect(details.every((u) => u.includes("foo-a"))).toBe(true);
  });

  test("cooldown: the next lookup fails fast without touching CoinGecko", async () => {
    handler = (url) => {
      if (url.includes("ks-setting.kyberswap.com")) return kyberMiss();
      if (url.includes("api.coingecko.com")) return rateLimited();
      throw new Error(`unexpected request: ${url}`);
    };

    await expect(resolveToken("FOOBAR", ETH)).rejects.toThrow(
      /rate limited \(HTTP 429\)/,
    );
    expect(__cgTest.cooldownRemainingMs()).toBeGreaterThan(0);

    const mark = calls.length;
    const started = Date.now();
    await expect(resolveToken("BARFOO", ETH)).rejects.toThrow(
      /rate limited \(HTTP 429\)/,
    );
    // Zero new CoinGecko requests (KyberSwap still runs — it is not the one
    // rate limiting us), and no waiting at all.
    expect(cgCalls(mark).length).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("address path: a 429 falls through to on-chain decimals()", async () => {
    const RPC = "https://rpc.test.invalid/";
    const saved = process.env.RPC_URL_1;
    process.env.RPC_URL_1 = RPC;
    try {
      handler = (url, init) => {
        if (url.includes("ks-setting.kyberswap.com")) return kyberMiss();
        if (url.includes("api.coingecko.com")) return rateLimited();
        if (url === RPC) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            method?: string;
            params?: Array<{ data?: string }>;
          };
          expect(body.method).toBe("eth_call");
          // decimals() selector.
          expect(body.params?.[0]?.data).toBe("0x313ce567");
          return json({
            jsonrpc: "2.0",
            id: 1,
            result: `0x${(6).toString(16).padStart(64, "0")}`,
          });
        }
        throw new Error(`unexpected request: ${url}`);
      };

      const token = await resolveToken(UNKNOWN_TOKEN, ETH);
      // Decimals came from the chain — never a guessed 18.
      expect(token.decimals).toBe(6);
      expect(token.source).toBe("onchain");
      expect(token.address).toBe(UNKNOWN_TOKEN);
    } finally {
      if (saved === undefined) delete process.env.RPC_URL_1;
      else process.env.RPC_URL_1 = saved;
    }
  });
});

describe("tokens.ts — Retry-After arithmetic", () => {
  test("retry wait is capped at 5s and defaults to 2s", () => {
    expect(coinGeckoRetryDelayMs("3600")).toBe(5_000); // cap, not 1h
    expect(coinGeckoRetryDelayMs("60")).toBe(5_000);
    expect(coinGeckoRetryDelayMs("3")).toBe(3_000);
    expect(coinGeckoRetryDelayMs("0")).toBe(0);
    expect(coinGeckoRetryDelayMs(null)).toBe(2_000);
    expect(coinGeckoRetryDelayMs("later")).toBe(2_000); // garbage → default
  });

  test("retry wait accepts the HTTP-date form, still capped", () => {
    const soon = new Date(Date.now() + 2_000).toUTCString();
    const far = new Date(Date.now() + 3_600_000).toUTCString();
    // Second granularity in the header ⇒ allow a little slack.
    expect(coinGeckoRetryDelayMs(soon)).toBeLessThanOrEqual(2_000);
    expect(coinGeckoRetryDelayMs(soon)).toBeGreaterThan(500);
    expect(coinGeckoRetryDelayMs(far)).toBe(5_000);
  });

  test("cooldown is at least 60s and at most 5 min", () => {
    expect(coinGeckoCooldownMs(null)).toBe(60_000);
    expect(coinGeckoCooldownMs("0")).toBe(60_000);
    expect(coinGeckoCooldownMs("10")).toBe(60_000); // floor
    expect(coinGeckoCooldownMs("120")).toBe(120_000);
    expect(coinGeckoCooldownMs("3600")).toBe(300_000); // cap
  });
});

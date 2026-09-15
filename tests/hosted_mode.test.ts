// Hosted mode (`--hosted` / `SWAP_API_URL`) — offline unit tests.
//
// Nothing here touches the network: `fetch` is stubbed per test. The subjects
// are the pure wire<->NormalizedQuote mapping, the NDJSON reader (chunk
// boundaries included), base resolution precedence, and the error mapping.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOSTED_DEFAULT,
  describeMode,
  remoteMode,
  remoteResolveToken,
  resolveApiBase,
  remoteSubmitUrl,
  routeQuoteToNormalized,
  venueResultsFromNdjson,
} from "../src/remote.ts";
import { resolveChain } from "../src/chains.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch;
}

async function* chunksOf(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

// ───────────────────────────── resolveApiBase ───────────────────────────────

describe("resolveApiBase", () => {
  test("no flag, no env → local engine", () => {
    expect(resolveApiBase({ env: {} })).toBeNull();
  });

  test("--hosted → the public deployment", () => {
    expect(resolveApiBase({ hosted: true, env: {} })).toBe(HOSTED_DEFAULT);
  });

  test("--local wins over SWAP_API_URL", () => {
    expect(
      resolveApiBase({ local: true, env: { SWAP_API_URL: "https://x.example" } }),
    ).toBeNull();
  });

  test("--hosted wins over SWAP_API_URL", () => {
    expect(
      resolveApiBase({ hosted: true, env: { SWAP_API_URL: "https://x.example" } }),
    ).toBe(HOSTED_DEFAULT);
  });

  test("--hosted with --local is refused", () => {
    expect(() => resolveApiBase({ hosted: true, local: true })).toThrow(
      /mutually exclusive/,
    );
  });

  test("SWAP_API_URL is used and its trailing slash trimmed", () => {
    expect(
      resolveApiBase({ env: { SWAP_API_URL: "http://127.0.0.1:5152/" } }),
    ).toBe("http://127.0.0.1:5152");
  });

  test("blank SWAP_API_URL is ignored", () => {
    expect(resolveApiBase({ env: { SWAP_API_URL: "   " } })).toBeNull();
  });

  test("a non-URL SWAP_API_URL fails loud", () => {
    expect(() => resolveApiBase({ env: { SWAP_API_URL: "swap.9summits.io" } })).toThrow(
      /not a valid URL/,
    );
  });

  test("a non-http(s) SWAP_API_URL fails loud", () => {
    expect(() =>
      resolveApiBase({ env: { SWAP_API_URL: "file:///etc/passwd" } }),
    ).toThrow(/http\(s\)/);
  });
});

// ───────────────────────────── describeMode ─────────────────────────────────

describe("describeMode", () => {
  test("a resolved base → `hosted <base>`", () => {
    expect(describeMode(HOSTED_DEFAULT)).toBe(`hosted ${HOSTED_DEFAULT}`);
  });

  test("no base → `self-hosted`", () => {
    expect(describeMode(null)).toBe("self-hosted");
  });
});

describe("SWAP_API_DISABLED", () => {
  const HOSTED = "https://x.example";

  test("absent → SWAP_API_URL still wins", () => {
    expect(resolveApiBase({ env: { SWAP_API_URL: HOSTED } })).toBe(HOSTED);
  });

  test("true → the local engine even with SWAP_API_URL set", () => {
    expect(
      resolveApiBase({
        env: { SWAP_API_URL: HOSTED, SWAP_API_DISABLED: "true" },
      }),
    ).toBeNull();
  });

  for (const v of ["1", "true", "TRUE", "  True  ", "yes", "YES", "on", "On"]) {
    test(`${JSON.stringify(v)} disables hosted mode`, () => {
      expect(
        resolveApiBase({ env: { SWAP_API_URL: HOSTED, SWAP_API_DISABLED: v } }),
      ).toBeNull();
    });
  }

  for (const v of ["0", "false", "FALSE", " False ", "no", "NO", "off", "Off", "", "   "]) {
    test(`${JSON.stringify(v)} leaves hosted mode on`, () => {
      expect(
        resolveApiBase({ env: { SWAP_API_URL: HOSTED, SWAP_API_DISABLED: v } }),
      ).toBe(HOSTED);
    });
  }

  test("an unrecognised value fails loud — no silent coercion", () => {
    expect(() =>
      resolveApiBase({ env: { SWAP_API_URL: HOSTED, SWAP_API_DISABLED: "maybe" } }),
    ).toThrow('SWAP_API_DISABLED must be true or false (got "maybe")');
  });

  test("--hosted wins over SWAP_API_DISABLED=true", () => {
    expect(
      resolveApiBase({
        hosted: true,
        env: { SWAP_API_URL: HOSTED, SWAP_API_DISABLED: "true" },
      }),
    ).toBe(HOSTED_DEFAULT);
  });

  test("--local with SWAP_API_DISABLED=false still forces local", () => {
    expect(
      resolveApiBase({
        local: true,
        env: { SWAP_API_URL: HOSTED, SWAP_API_DISABLED: "false" },
      }),
    ).toBeNull();
  });

  test("disabled with no SWAP_API_URL is still just local", () => {
    expect(resolveApiBase({ env: { SWAP_API_DISABLED: "1" } })).toBeNull();
  });

  test("an invalid URL is never reached once hosted mode is disabled", () => {
    expect(
      resolveApiBase({
        env: { SWAP_API_URL: "swap.9summits.io", SWAP_API_DISABLED: "true" },
      }),
    ).toBeNull();
  });
});

describe("remoteSubmitUrl", () => {
  test("a server-rewritten relative url resolves against the base", () => {
    expect(
      remoteSubmitUrl("https://swap.9summits.io", {
        submit: { url: "/submit?venue=fusion&chainId=1" },
      }),
    ).toBe("https://swap.9summits.io/submit?venue=fusion&chainId=1");
  });

  test("a public relayer url is left untouched", () => {
    expect(
      remoteSubmitUrl("https://swap.9summits.io", {
        submit: { url: "https://api.cow.fi/mainnet/api/v1/orders" },
      }),
    ).toBe("https://api.cow.fi/mainnet/api/v1/orders");
  });
});

// ───────────────────────────── route mapping ────────────────────────────────

const FULL_ROW = {
  venue: "kyber",
  amountIn: "1000000000",
  amountOut: "271828182845904523",
  minAmountOut: "271556354663445470",
  gasUsd: 1.25,
  priceImpactPct: -0.03,
  kind: "sync",
  gasUnits: 210000,
  gasPriceWei: "3000000000",
  amountInUsd: 1000,
  amountOutUsd: 999.7,
  hops: [
    {
      tokenIn: "0xa0b8",
      tokenOut: "0xc02a",
      exchange: "uniswapv3",
      swapAmount: "1000000000",
    },
  ],
  router: "0x6131b5fae19ea4f9d964eac0408e4408b66337b5",
  protocolFee: { raw: "12345", sharePct: 0.05, side: "out" },
  tokenHints: {
    "0xC02A": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  },
};

describe("routeQuoteToNormalized", () => {
  test("maps a complete row", () => {
    const q = routeQuoteToNormalized(FULL_ROW, { side: "sell" });
    expect(q.venue).toBe("kyber");
    expect(q.amountIn).toBe("1000000000");
    expect(q.amountOut).toBe("271828182845904523");
    expect(q.minAmountOut).toBe("271556354663445470");
    expect(q.gasUsd).toBe(1.25);
    expect(q.gasUnits).toBe(210000);
    expect(q.gasPriceWei).toBe("3000000000");
    expect(q.router).toBe("0x6131b5fae19ea4f9d964eac0408e4408b66337b5");
    expect(q.hops).toHaveLength(1);
    expect(q.protocolFee).toEqual({ raw: "12345", sharePct: 0.05, side: "out" });
    expect(q.raw).toBe(FULL_ROW);
  });

  test("tokenHints becomes a Map keyed by lowercase address", () => {
    const q = routeQuoteToNormalized(FULL_ROW, { side: "sell" });
    expect(q.tokenHints).toBeInstanceOf(Map);
    expect(q.tokenHints.get("0xc02a")).toEqual({
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
    });
  });

  test("a hint without real decimals is dropped, never defaulted to 18", () => {
    const q = routeQuoteToNormalized(
      { ...FULL_ROW, tokenHints: { "0xdead": { symbol: "X", name: "X" } } },
      { side: "sell" },
    );
    expect(q.tokenHints.size).toBe(0);
  });

  test("a pre-versioning row (no hops/router/protocolFee/tokenHints) still maps", () => {
    const q = routeQuoteToNormalized(
      {
        venue: "velora",
        amountIn: "1",
        amountOut: "2",
        kind: "sync",
        gasUsd: null,
        gasUnits: null,
        gasPriceWei: null,
      },
      { side: "sell" },
    );
    expect(q.hops).toEqual([]);
    expect(q.router).toBeNull();
    expect(q.protocolFee).toBeNull();
    expect(q.tokenHints.size).toBe(0);
    expect(q.amountInUsd).toBeNull();
    expect(q.amountOutUsd).toBeNull();
  });

  test("a row with no venue / no amounts fails loud", () => {
    expect(() => routeQuoteToNormalized({ amountIn: "1" }, { side: "sell" })).toThrow(
      /no venue/,
    );
    expect(() =>
      routeQuoteToNormalized({ venue: "kyber", amountIn: "1" }, { side: "sell" }),
    ).toThrow(/amountOut/);
  });

  test("buyRefine:true rebuilds the local {targetAmountOut, seedAmountIn} shape", () => {
    const q = routeQuoteToNormalized(
      { ...FULL_ROW, buyRefine: true },
      { side: "buy", targetAmountOut: 500n },
    );
    expect(q.buyRefine).toEqual({
      targetAmountOut: "500",
      seedAmountIn: "1000000000",
    });
  });

  test("no buyRefine flag → no buyRefine tag", () => {
    expect(routeQuoteToNormalized(FULL_ROW, { side: "sell" }).buyRefine).toBeUndefined();
  });
});

// ───────────────────────────── NDJSON stream ────────────────────────────────

const routeLine = (venue: string, out: string) =>
  JSON.stringify({
    type: "route",
    route: { venue, amountIn: "100", amountOut: out, kind: "sync" },
  });

describe("venueResultsFromNdjson", () => {
  test("meta is ignored, route/verror surface, done ends the stream", async () => {
    const results = await collect(
      venueResultsFromNdjson(
        chunksOf(
          `{"type":"meta","quoteId":"abc"}\n`,
          `${routeLine("kyber", "200")}\n`,
          `{"type":"verror","venue":"matcha","error":"no route"}\n`,
          `{"type":"done","expiresAt":1}\n`,
          `${routeLine("velora", "999")}\n`,
        ),
        { side: "sell" },
      ),
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ venue: "kyber" });
    expect("quote" in results[0]! && results[0].quote.amountOut).toBe("200");
    expect(results[1]).toEqual({ venue: "matcha", error: "no route" });
  });

  test("a line split across two chunks is reassembled", async () => {
    const line = routeLine("kyber", "4242");
    const cut = Math.floor(line.length / 2);
    const results = await collect(
      venueResultsFromNdjson(
        chunksOf(line.slice(0, cut), `${line.slice(cut)}\n`),
        { side: "sell" },
      ),
    );
    expect(results).toHaveLength(1);
    expect("quote" in results[0]! && results[0].quote.amountOut).toBe("4242");
  });

  test("a trailing line with no newline is still emitted", async () => {
    const results = await collect(
      venueResultsFromNdjson(chunksOf(routeLine("odos", "7")), { side: "sell" }),
    );
    expect(results).toHaveLength(1);
  });

  test("a flattened route event (no `route` envelope) is accepted", async () => {
    const results = await collect(
      venueResultsFromNdjson(
        chunksOf(
          `{"type":"route","venue":"kyber","amountIn":"1","amountOut":"2","kind":"sync"}\n`,
        ),
        { side: "sell" },
      ),
    );
    expect("quote" in results[0]! && results[0].quote.amountOut).toBe("2");
  });

  test("fatal throws with the server's reason", async () => {
    await expect(
      collect(
        venueResultsFromNdjson(
          chunksOf(`{"type":"fatal","error":"engine exploded"}\n`),
          { side: "sell" },
        ),
      ),
    ).rejects.toThrow("engine exploded");
  });

  test("an unparseable line is logged and skipped, the stream survives", async () => {
    const orig = console.error;
    const logs: string[] = [];
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      const results = await collect(
        venueResultsFromNdjson(
          chunksOf(`{oops\n`, `${routeLine("kyber", "5")}\n`),
          { side: "sell" },
        ),
      );
      expect(results).toHaveLength(1);
      expect(logs.join("\n")).toContain("unparseable line");
    } finally {
      console.error = orig;
    }
  });
});

// ───────────────────────────── error mapping ────────────────────────────────

const BASE = "http://127.0.0.1:5152";

describe("hosted error mapping", () => {
  test("429 surfaces Retry-After in seconds", async () => {
    stubFetch(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "12" },
        }),
    );
    await expect(remoteMode(BASE)).rejects.toThrow(
      "hosted API rate limited, retry in 12 s",
    );
  });

  test("429 without Retry-After falls back to 60 s", async () => {
    stubFetch(() => new Response("slow down", { status: 429 }));
    await expect(remoteMode(BASE)).rejects.toThrow(/retry in 60 s/);
  });

  test("a network failure names the base and points at --local", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("connect ECONNREFUSED"))) as typeof fetch;
    await expect(remoteMode(BASE)).rejects.toThrow(
      `hosted API unreachable (${BASE}): connect ECONNREFUSED. Retry later, or run with --local and your own keys`,
    );
  });

  test("a 4xx/5xx body's `error` field becomes the message", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "venue kyber is disabled" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(remoteMode(BASE)).rejects.toThrow("venue kyber is disabled");
  });

  test("never falls back to the local engine — the error propagates", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(remoteMode(BASE)).rejects.toThrow();
  });
});

// ───────────────────────────── /api/mode ────────────────────────────────────

describe("remoteMode", () => {
  test("a missing apiVersion is a contract mismatch", async () => {
    stubFetch(() => Response.json({ interactive: true, venues: [], chains: [] }));
    await expect(remoteMode(BASE)).rejects.toThrow(
      "hosted API contract mismatch (expected 1, got none); run `swap update`",
    );
  });

  test("a different apiVersion is a contract mismatch", async () => {
    stubFetch(() => Response.json({ apiVersion: 2, venues: [], chains: [] }));
    await expect(remoteMode(BASE)).rejects.toThrow(
      /expected 1, got 2/,
    );
  });

  test("known venues and chains are kept, unknown venues dropped", async () => {
    stubFetch(() =>
      Response.json({
        apiVersion: 1,
        chains: [
          {
            alias: "eth",
            chainId: 1,
            name: "Ethereum",
            explorer: "https://etherscan.io",
            nativeSymbol: "ETH",
            wrappedNative: "0xc02a",
          },
          { alias: "broken" },
        ],
        venues: [
          { name: "kyber", kind: "sync" },
          { name: "cow", kind: "async" },
          { name: "notavenue", kind: "sync" },
        ],
        buyVenues: ["kyber", "nope"],
        defaultChain: "eth",
      }),
    );
    const mode = await remoteMode(BASE);
    expect(mode.venues.map((v) => v.name)).toEqual(["kyber", "cow"]);
    expect(mode.venues[1]!.kind).toBe("async");
    expect(mode.chains).toHaveLength(1);
    expect(mode.buyVenues).toEqual(["kyber"]);
    expect(mode.defaultChain).toBe("eth");
  });

  test("the CLI identifies itself on every request", async () => {
    let seen: Record<string, string> = {};
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(Response.json({ apiVersion: 1, venues: [], chains: [] }));
    }) as typeof fetch;
    await remoteMode(BASE);
    expect(seen["x-swap-client"]).toBe("cli");
    expect(seen["user-agent"]).toMatch(/^swap-cli\//);
  });
});

// ───────────────────────────── resolve-token ────────────────────────────────

describe("remoteResolveToken", () => {
  const chain = resolveChain("eth");

  test("maps the server token and keeps its decimals", async () => {
    stubFetch(() =>
      Response.json({
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      }),
    );
    const t = await remoteResolveToken({ base: BASE, chain, input: "usdc" });
    expect(t.decimals).toBe(6);
    expect(t.symbol).toBe("USDC");
    expect(t.chainId).toBe(1);
    expect(t.source).toBe("hosted");
  });

  test("a missing decimals fails loud instead of defaulting to 18", async () => {
    stubFetch(() => Response.json({ address: "0xdead", symbol: "X", name: "X" }));
    await expect(
      remoteResolveToken({ base: BASE, chain, input: "x" }),
    ).rejects.toThrow(/no usable decimals/);
  });

  test("a string decimals fails loud (no coercion)", async () => {
    stubFetch(() =>
      Response.json({ address: "0xdead", symbol: "X", decimals: "18" }),
    );
    await expect(
      remoteResolveToken({ base: BASE, chain, input: "x" }),
    ).rejects.toThrow(/no usable decimals/);
  });

  test("a missing address fails loud", async () => {
    stubFetch(() => Response.json({ symbol: "X", decimals: 18 }));
    await expect(
      remoteResolveToken({ base: BASE, chain, input: "x" }),
    ).rejects.toThrow(/no address/);
  });
});

// ───────────────────────────── build embed ──────────────────────────────────

describe("embed-env", () => {
  test("SWAP_API_URL survives the public-build filter (RPC keys don't)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swap-embed-"));
    const envFile = join(dir, ".env.install");
    writeFileSync(
      envFile,
      "SWAP_API_URL=https://swap.9summits.io\nALCHEMY_API_KEY=secret\nETH_RPC_URL=https://x\n",
    );
    const proc = Bun.spawn(["bun", "scripts/embed-env.ts", envFile], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("SWAP_API_URL");
    expect(out).toContain("https://swap.9summits.io");
    expect(out).not.toContain("ALCHEMY_API_KEY");
    expect(out).not.toContain("ETH_RPC_URL");
  });
});

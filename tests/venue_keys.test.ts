import { afterEach, expect, test } from "bun:test";
import {
  availableVenues,
  missingApiKeySkips,
  skippedVenues,
} from "../src/venues/index.ts";
import { formatMissingApiKeyNote } from "../src/format.ts";
import { buildTx, quote as openoceanQuote } from "../src/venues/openocean.ts";
import { resolveChain } from "../src/chains.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

const KEY = "OPENOCEAN_API_KEY";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const eth = resolveChain("eth");

const saved = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers as Record<string, string> | undefined;
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

type Captured = { url: string; headers: Record<string, string> };

async function captureQuote(): Promise<Captured> {
  let cap: Captured = { url: "", headers: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    cap = { url: String(input), headers: headersOf(init) };
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          inAmount: "1000000000000000000",
          outAmount: "2471000000",
          estimatedGas: "150000",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  await openoceanQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 10n ** 18n,
    slippageBps: 50,
  });
  return cap;
}

async function captureBuild(): Promise<Captured> {
  let cap: Captured = { url: "", headers: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    cap = { url: String(input), headers: headersOf(init) };
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          to: "0x6352a56caadC4F1E25CD6c75970Fa768A3304e64",
          data: "0xdeadbeef",
          value: "0",
          estimatedGas: "150000",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const q = {
    venue: "openocean",
    amountIn: "1000000000000000000",
    amountOut: "2471000000",
  } as unknown as NormalizedQuote;
  await buildTx({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 10n ** 18n,
    sender: SENDER,
    slippageBps: 50,
    quote: q,
  });
  return cap;
}

test("openocean: no key stays in -v all (public host)", () => {
  setEnv({ [KEY]: undefined });
  expect(availableVenues({ allowAsync: true })).toContain("openocean");
  expect(
    skippedVenues({ allowAsync: true }).some((s) => s.venue === "openocean"),
  ).toBe(false);
});

test("openocean: no key → public host with origin+referer, no apikey", async () => {
  setEnv({ [KEY]: undefined });
  const q = await captureQuote();
  expect(q.url.startsWith("https://open-api.openocean.finance/v4/eth/quote?")).toBe(
    true,
  );
  expect(q.headers.apikey).toBeUndefined();
  expect(q.headers.origin).toBe("https://app.openocean.finance");
  expect(q.headers.referer).toBe("https://app.openocean.finance/");

  const b = await captureBuild();
  expect(b.url.startsWith("https://open-api.openocean.finance/v4/eth/swap?")).toBe(
    true,
  );
  expect(b.headers.apikey).toBeUndefined();
  expect(b.headers.origin).toBe("https://app.openocean.finance");
  expect(b.headers.referer).toBe("https://app.openocean.finance/");
});

test("openocean: OPENOCEAN_API_KEY → enterprise host, apikey, no origin", async () => {
  setEnv({ [KEY]: "test-key" });
  expect(availableVenues({ allowAsync: true })).toContain("openocean");

  const q = await captureQuote();
  expect(
    q.url.startsWith("https://open-api-enterprise.openocean.finance/v4/eth/quote?"),
  ).toBe(true);
  expect(q.headers.apikey).toBe("test-key");
  expect(q.headers.origin).toBeUndefined();
  expect(q.headers.referer).toBeUndefined();

  const b = await captureBuild();
  expect(
    b.url.startsWith("https://open-api-enterprise.openocean.finance/v4/eth/swap?"),
  ).toBe(true);
  expect(b.headers.apikey).toBe("test-key");
  expect(b.headers.origin).toBeUndefined();
});

function clearVenueKeys(): void {
  setEnv({
    ZEROEX_API_KEY: undefined,
    ONEINCH_API_KEY: undefined,
    UNISWAP_API_KEY: undefined,
    OPHIS_REFERRAL_CODE: undefined,
  });
}

test("missingApiKeySkips: no keys + allowAsync lists matcha/1inch/fusion/uniswap/uniswapx, not ophis", () => {
  clearVenueKeys();
  const skips = missingApiKeySkips({ allowAsync: true });
  expect(skips.map((s) => s.venue)).toEqual([
    "matcha",
    "1inch",
    "uniswap",
    "uniswapx",
    "fusion",
  ]);
  expect(skips.some((s) => s.venue === "ophis")).toBe(false);
  expect(new Set(skips.map((s) => s.envVar))).toEqual(
    new Set(["ZEROEX_API_KEY", "ONEINCH_API_KEY", "UNISWAP_API_KEY"]),
  );
});

test("missingApiKeySkips: without allowAsync drops fusion/uniswapx (async first)", () => {
  clearVenueKeys();
  expect(missingApiKeySkips({ allowAsync: false }).map((s) => s.venue)).toEqual([
    "matcha",
    "1inch",
    "uniswap",
  ]);
});

test("missingApiKeySkips: comma-list intersects the requested venues", () => {
  clearVenueKeys();
  expect(
    missingApiKeySkips({
      allowAsync: true,
      venues: ["kyber", "matcha"],
    }).map((s) => s.venue),
  ).toEqual(["matcha"]);
  expect(
    missingApiKeySkips({ allowAsync: true, venues: ["kyber", "velora"] }),
  ).toEqual([]);
});

test("missingApiKeySkips: empty when keys are set", () => {
  setEnv({
    ZEROEX_API_KEY: "x",
    ONEINCH_API_KEY: "x",
    UNISWAP_API_KEY: "x",
  });
  expect(missingApiKeySkips({ allowAsync: true })).toEqual([]);
});

test("formatMissingApiKeyNote: names venues and env vars, null when empty", () => {
  expect(formatMissingApiKeyNote([])).toBeNull();
  const note = formatMissingApiKeyNote([
    { venue: "matcha", envVar: "ZEROEX_API_KEY" },
    { venue: "1inch", envVar: "ONEINCH_API_KEY" },
    { venue: "fusion", envVar: "ONEINCH_API_KEY" },
  ]);
  expect(note).not.toBeNull();
  const plain = note!.replace(/\x1b\[[0-9;]*m/g, "");
  expect(plain).toContain("skipped matcha, 1inch, fusion — no API key");
  expect(plain).toContain("set ZEROEX_API_KEY, ONEINCH_API_KEY in .env");
});

import { afterEach, expect, test } from "bun:test";
import { buildTx, quote as kyberQuote } from "../src/venues/kyber.ts";
import {
  resetReferralConfigCache,
  resetReferralMode,
  setNoFeeMode,
  setReferralMode,
} from "../src/referral.ts";
import { resolveChain } from "../src/chains.ts";
import type { NormalizedQuote } from "../src/venues/types.ts";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const eth = resolveChain("eth");

const KEYS = [
  "KYBER_API_KEY",
  "KYBER_API_BASE",
  "KYBER_SOURCE",
  "KYBER_REFERRAL",
  "REFERRAL_ADDRESS",
  "REFERRAL_FEE_BPS",
  "REFERRAL_NAME",
] as const;
type Key = (typeof KEYS)[number];

const realFetch = globalThis.fetch;
const saved = new Map<Key, string | undefined>();

// Every key is set or deleted on each call so the repo .env (auto-loaded by
// Bun) can never decide a case.
function setEnv(vars: Partial<Record<Key, string>>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetReferralConfigCache();
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  setNoFeeMode(false);
  resetReferralMode();
  resetReferralConfigCache();
});

type Captured = { url: string; headers: Record<string, string>; body: unknown };

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers as Record<string, string> | undefined;
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}

async function captureQuote(): Promise<Captured> {
  let cap: Captured = { url: "", headers: {}, body: null };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    cap = { url: String(input), headers: headersOf(init), body: null };
    return new Response(
      JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          routeSummary: {
            tokenIn: WETH,
            amountIn: "1000000000000000000",
            amountInUsd: "3500",
            tokenOut: USDC,
            amountOut: "3500000000",
            amountOutUsd: "3500",
            gas: "150000",
            gasPrice: "1000000000",
            gasUsd: "0.5",
            route: [],
          },
          routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  await kyberQuote({ chain: eth, tokenIn: WETH, tokenOut: USDC, amountIn: 10n ** 18n });
  return cap;
}

async function captureBuild(): Promise<Captured> {
  let cap: Captured = { url: "", headers: {}, body: null };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    cap = { url: String(input), headers: headersOf(init), body: JSON.parse(String(init?.body)) };
    return new Response(
      JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          amountIn: "1000000000000000000",
          amountOut: "3500000000",
          gas: "150000",
          gasUsd: "0.5",
          data: "0xdeadbeef",
          routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const q = {
    venue: "kyber",
    amountIn: "1000000000000000000",
    amountOut: "3500000000",
    raw: { routeSummary: { amountIn: "1" }, routerAddress: "0x" },
    gasPriceWei: null,
  } as unknown as NormalizedQuote;
  await buildTx({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 10n ** 18n,
    sender: SENDER,
    slippageBps: 10,
    quote: q,
  } as Parameters<typeof buildTx>[0]);
  return cap;
}

test("kyber: nothing configured → public host, x-client-id only, no source/referral", async () => {
  setEnv({ REFERRAL_NAME: "swap" });
  setReferralMode("cli");

  const q = await captureQuote();
  expect(q.url.startsWith("https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?")).toBe(true);
  expect(q.headers["x-client-id"]).toBe("swap-cli");
  expect(q.headers["x-api-key"]).toBeUndefined();
  const qFee = new URL(q.url).searchParams;
  expect(qFee.get("feeReceiver")).toBeNull();
  expect(qFee.get("feeAmount")).toBeNull();
  expect(qFee.get("isInBps")).toBeNull();
  expect(qFee.get("chargeFeeBy")).toBeNull();

  const b = await captureBuild();
  expect(b.url).toBe("https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build");
  expect(b.headers["x-api-key"]).toBeUndefined();
  const body = b.body as Record<string, unknown>;
  expect("source" in body).toBe(false);
  expect("referral" in body).toBe(false);
  expect("feeReceiver" in body).toBe(false);
  expect("feeAmount" in body).toBe(false);
  expect("isInBps" in body).toBe(false);
  expect("chargeFeeBy" in body).toBe(false);
});

test("kyber: KYBER_API_KEY → gateway base + X-Api-Key on quote and build", async () => {
  setEnv({ REFERRAL_NAME: "swap", KYBER_API_KEY: "k-123" });
  setReferralMode("cli");

  const q = await captureQuote();
  expect(q.url.startsWith("https://api.kyberswap.com/swap/ethereum/api/v1/routes?")).toBe(true);
  expect(q.headers["x-api-key"]).toBe("k-123");
  expect(q.headers["x-client-id"]).toBe("swap-cli");

  const b = await captureBuild();
  expect(b.url).toBe("https://api.kyberswap.com/swap/ethereum/api/v1/route/build");
  expect(b.headers["x-api-key"]).toBe("k-123");
});

test("kyber: KYBER_API_BASE overrides the base (trailing slash tolerated), with or without a key", async () => {
  setEnv({ REFERRAL_NAME: "swap", KYBER_API_BASE: "https://example.test/kyber/" });
  setReferralMode("cli");
  const q = await captureQuote();
  expect(q.url.startsWith("https://example.test/kyber/ethereum/api/v1/routes?")).toBe(true);
  expect(q.headers["x-api-key"]).toBeUndefined();
});

test("kyber: gateway KYBER_API_BASE without a key uses the public host", async () => {
  setEnv({ REFERRAL_NAME: "swap", KYBER_API_BASE: "https://api.kyberswap.com/swap" });
  setReferralMode("cli");

  const q = await captureQuote();
  expect(q.url.startsWith("https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?")).toBe(true);
  expect(q.headers["x-api-key"]).toBeUndefined();

  const b = await captureBuild();
  expect(b.url).toBe("https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build");
  expect(b.headers["x-api-key"]).toBeUndefined();
});

test("kyber: KYBER_SOURCE / KYBER_REFERRAL land in the build body only", async () => {
  setEnv({ REFERRAL_NAME: "swap", KYBER_SOURCE: "swap", KYBER_REFERRAL: "9SUMMITS" });
  setReferralMode("dapp");

  const q = await captureQuote();
  const qs = new URL(q.url).searchParams;
  expect(qs.get("source")).toBeNull();
  expect(qs.get("referral")).toBeNull();

  const b = await captureBuild();
  const body = b.body as Record<string, unknown>;
  expect(body.source).toBe("swap");
  expect(body.referral).toBe("9SUMMITS");
  expect(b.headers["x-client-id"]).toBe("swap-dapp");
});

test("kyber: partner fee fields still ride along with attribution", async () => {
  setEnv({
    REFERRAL_NAME: "swap",
    REFERRAL_ADDRESS: SENDER,
    REFERRAL_FEE_BPS: "25",
    KYBER_SOURCE: "swap",
  });
  setReferralMode("cli");
  const q = await captureQuote();
  const qs = new URL(q.url).searchParams;
  expect(qs.get("feeReceiver")).toBe(SENDER);
  expect(qs.get("feeAmount")).toBe("25");
  expect(qs.get("isInBps")).toBe("true");
  expect(qs.get("chargeFeeBy")).toBe("currency_out");
  const b = await captureBuild();
  const body = b.body as Record<string, unknown>;
  expect(body.feeReceiver).toBe(SENDER);
  expect(body.feeAmount).toBe("25");
  expect(body.isInBps).toBe(true);
  expect(body.chargeFeeBy).toBe("currency_out");
  expect(body.source).toBe("swap");
});

test("kyber: REFERRAL_ADDRESS set and feeBps 0 (unset or \"0\") still sends the quartet on quote and build", async () => {
  for (const feeBps of [undefined, "0"] as const) {
    setEnv({
      REFERRAL_NAME: "swap",
      REFERRAL_ADDRESS: SENDER,
      ...(feeBps === undefined ? {} : { REFERRAL_FEE_BPS: feeBps }),
    });
    setReferralMode("cli");
    const q = await captureQuote();
    const qs = new URL(q.url).searchParams;
    expect(qs.get("feeReceiver")).toBe(SENDER);
    expect(qs.get("feeAmount")).toBe("0");
    expect(qs.get("isInBps")).toBe("true");
    expect(qs.get("chargeFeeBy")).toBe("currency_out");
    const b = await captureBuild();
    const body = b.body as Record<string, unknown>;
    expect(body.feeReceiver).toBe(SENDER);
    expect(body.feeAmount).toBe("0");
    expect(body.isInBps).toBe(true);
    expect(body.chargeFeeBy).toBe("currency_out");
  }
});

test("kyber: setNoFeeMode keeps feeReceiver at feeAmount 0 on quote and build", async () => {
  setEnv({
    REFERRAL_NAME: "swap",
    REFERRAL_ADDRESS: SENDER,
    REFERRAL_FEE_BPS: "25",
  });
  setReferralMode("cli");
  setNoFeeMode(true);
  const q = await captureQuote();
  const qs = new URL(q.url).searchParams;
  expect(qs.get("feeReceiver")).toBe(SENDER);
  expect(qs.get("feeAmount")).toBe("0");
  expect(qs.get("isInBps")).toBe("true");
  expect(qs.get("chargeFeeBy")).toBe("currency_out");
  const b = await captureBuild();
  const body = b.body as Record<string, unknown>;
  expect(body.feeReceiver).toBe(SENDER);
  expect(body.feeAmount).toBe("0");
  expect(body.isInBps).toBe(true);
  expect(body.chargeFeeBy).toBe("currency_out");
});

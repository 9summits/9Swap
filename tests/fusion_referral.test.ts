import { afterEach, expect, test } from "bun:test";
import { quote as fusionQuote } from "../src/venues/fusion.ts";
import {
  resetReferralConfigCache,
  resetReferralMode,
  setNoFeeMode,
  setReferralMode,
} from "../src/referral.ts";
import { resolveChain } from "../src/chains.ts";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const RECEIVER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const eth = resolveChain("eth");

process.env.ONEINCH_API_KEY ||= "test-key";

const REFERRAL_KEYS = ["REFERRAL_ADDRESS", "REFERRAL_NAME", "REFERRAL_FEE_BPS", "FUSION_FEE_ENABLED"] as const;
type ReferralKey = (typeof REFERRAL_KEYS)[number];

const realFetch = globalThis.fetch;
const saved = new Map<ReferralKey, string | undefined>();

// Bun auto-loads the repo .env, which really does set REFERRAL_ADDRESS and
// REFERRAL_FEE_BPS. Every key is set or deleted on each call so a changed .env
// can never decide a case.
function setReferralEnv(vars: Partial<Record<ReferralKey, string>>): void {
  for (const k of REFERRAL_KEYS) {
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

async function captureQuoteUrl(): Promise<URL> {
  let capturedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return new Response(
      JSON.stringify({
        fromTokenAmount: "1000000000000000000",
        toTokenAmount: "3500000000",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  await fusionQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 10n ** 18n,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
  });

  return new URL(capturedUrl);
}

test("fusion quote: fee is the raw bps integer, never a percent", async () => {
  setReferralEnv({
    REFERRAL_ADDRESS: RECEIVER,
    REFERRAL_FEE_BPS: "50",
    REFERRAL_NAME: "swagg",
    FUSION_FEE_ENABLED: "1",
  });

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("fee")).toBe("50");
  expect(u.searchParams.get("source")).toBe("swagg");
});

test("fusion quote: fee stays off until FUSION_FEE_ENABLED=1 (1inch 400s otherwise)", async () => {
  setReferralEnv({
    REFERRAL_ADDRESS: RECEIVER,
    REFERRAL_FEE_BPS: "50",
    REFERRAL_NAME: "swagg",
  });

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("fee")).toBeNull();
  expect(u.searchParams.get("source")).toBe("swagg");
});

test("fusion quote: REFERRAL_FEE_BPS=0 sends no fee param, source still tagged", async () => {
  setReferralEnv({
    REFERRAL_ADDRESS: RECEIVER,
    REFERRAL_FEE_BPS: "0",
    REFERRAL_NAME: "swagg",
  });

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("fee")).toBeNull();
  expect(u.searchParams.get("source")).toBe("swagg");
});

test("fusion quote: source falls back to swap-selfhost when REFERRAL_NAME is unset", async () => {
  setReferralEnv({});

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("source")).toBe("swap-selfhost");
  expect(u.searchParams.get("fee")).toBeNull();
});

test("fusion quote: the CLI mode suffix reaches the wire", async () => {
  setReferralEnv({});
  setReferralMode("cli");

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("source")).toBe("swap-selfhost-cli");
});

test("fusion quote: --nofee drops the fee and keeps source", async () => {
  setReferralEnv({
    REFERRAL_ADDRESS: RECEIVER,
    REFERRAL_FEE_BPS: "50",
    REFERRAL_NAME: "swagg",
    FUSION_FEE_ENABLED: "1",
  });
  setNoFeeMode(true);

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("fee")).toBeNull();
  expect(u.searchParams.get("source")).toBe("swagg");
});

test("fusion quote: omitted settlementAddress on 4663 uses the live settlement, not the empty shared deploy", async () => {
  setReferralEnv({});
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        fromTokenAmount: "10000000000000000",
        toTokenAmount: "1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const q = await fusionQuote({
    chain: resolveChain("robinhood"),
    tokenIn: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    amountIn: 10n ** 16n,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
  });
  expect(q.router).toBe("0xb55ba9617DAfaE1236313C3Cb7806439CEefBD13");
});

test("fusion quote: omitted settlementAddress on other chains keeps the shared deploy", async () => {
  setReferralEnv({});
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        fromTokenAmount: "1000000000000000000",
        toTokenAmount: "3500000000",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const q = await fusionQuote({
    chain: eth,
    tokenIn: WETH,
    tokenOut: USDC,
    amountIn: 10n ** 18n,
    tokenInDecimals: 18,
    tokenOutDecimals: 6,
  });
  expect(q.router).toBe("0xFb2809A5314473E1165f6B58018E20ed8F07B840");
});

test("fusion quote: FUSION_FEE_ENABLED=true is not the opt-in, only =1 is", async () => {
  setReferralEnv({
    REFERRAL_ADDRESS: RECEIVER,
    REFERRAL_FEE_BPS: "50",
    REFERRAL_NAME: "swagg",
    FUSION_FEE_ENABLED: "true",
  });

  const u = await captureQuoteUrl();
  expect(u.searchParams.get("fee")).toBeNull();
  expect(u.searchParams.get("source")).toBe("swagg");
});

import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  Eip712TypedData,
  NormalizedHop,
  NormalizedOrder,
  NormalizedQuote,
} from "./types.ts";
import {
  MissingApiKeyError,
  UnsupportedChainError,
  toNumOrNull,
} from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { toChecksumAddress } from "../checksum.ts";
import { getReferralConfig } from "../referral.ts";

// 1inch Fusion runs on every chain the classic /swap/v6 product covers.
// Tighten the whitelist as Fusion's chain coverage evolves.
// Arc (5042) is deliberately ABSENT: the quoter does answer for it, but the
// resolver `whitelist` it returns is six zero addresses — no resolver is
// onboarded on Arc, so an order would be signed and never filled (probed
// 2026-09-16). Flip it on once the whitelist holds real resolvers.
const FUSION_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 100, 130, 137, 143, 250, 8453, 42161, 43114, 59144, 324, 146,
  4663,
]);

// Quote `router` fallback when the quoter omits settlementAddress.
// Shared deploy on most Fusion chains. Empty on Robinhood (4663), which
// uses FUSION_SETTLEMENT_ROBINHOOD instead. Build spender is
// typedData.domain.verifyingContract (LOP v4), not settlement.
const FUSION_SETTLEMENT = "0xFb2809A5314473E1165f6B58018E20ed8F07B840";
const FUSION_SETTLEMENT_ROBINHOOD = "0xb55ba9617DAfaE1236313C3Cb7806439CEefBD13";

function fusionSettlementFallback(chainId: number): string {
  return chainId === 4663 ? FUSION_SETTLEMENT_ROBINHOOD : FUSION_SETTLEMENT;
}

function rejectIfNative(addr: string, role: "tokenIn" | "tokenOut"): void {
  if (addr.toLowerCase() === NATIVE_SENTINEL) {
    throw new Error(
      `fusion does not support native ETH as ${role} — wrap to WETH (or the chain's wrapped native) and pass that address.`,
    );
  }
}

function referralSource(): string {
  return getReferralConfig().name;
}

// 1inch gates integrator fees per API key and rejects any non-zero `fee`
// with a hard 400 on keys where they are off (measured 2026-09-03), so the
// fee is opt-in: set FUSION_FEE_ENABLED=1 once 1inch enables it on your key.
// Quote and build both read this so they never diverge.
function fusionFeeBps(): number {
  if (process.env.FUSION_FEE_ENABLED !== "1") return 0;
  return getReferralConfig().feeBps;
}

type FusionPreset = {
  auctionDuration?: number;
  startAuctionIn?: number;
  initialRateBump?: number;
  auctionStartAmount?: string;
  auctionEndAmount?: string;
  startAmount?: string;
  endAmount?: string;
  tokenFee?: string;
  estP?: number;
};

type FusionPresetName = "fast" | "medium" | "slow" | "custom";

type FusionQuoteResponse = {
  fromTokenAmount?: string;
  toTokenAmount?: string;
  // Auction presets — Fusion picks one based on the user's preference.
  presets?: {
    fast?: FusionPreset;
    medium?: FusionPreset;
    slow?: FusionPreset;
    custom?: FusionPreset;
  };
  recommendedPreset?: FusionPresetName;
  // Wire name from GET /quote/receive (SDK maps this to recommendedPreset).
  recommended_preset?: FusionPresetName;
  prices?: {
    usd?: { fromToken?: string; toToken?: string };
  };
  feeToken?: string;
  whitelist?: string[];
  quoteId?: string;
  settlementAddress?: string;
  description?: string;
  error?: string;
  statusCode?: number;
};

/**
 * Fusion quoter/SDK `slippage` is percent, not bps (same unit as classic 1inch).
 * 10 bps → 0.1. Undefined when the value isn't a usable number — callers omit
 * the query/body field rather than sending NaN.
 */
export function fusionSlippagePercent(slippageBps: number): number | undefined {
  if (!Number.isFinite(slippageBps) || slippageBps < 0) return undefined;
  return slippageBps / 100;
}

function parsePositiveAmount(s: string | undefined): bigint | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    const n = BigInt(s);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function isPresetName(s: string | undefined): s is FusionPresetName {
  return s === "fast" || s === "medium" || s === "slow" || s === "custom";
}

/**
 * Signed Fusion orders set `takingAmount = recommendedPreset.auctionEndAmount`
 * (Dutch-auction floor). Headline `toTokenAmount` is the expected/start cote
 * and overstates what pickBest should compare against other venues.
 *
 * Returns the floor as a base-units string only when it is strictly below the
 * cote — otherwise ranking can keep using amountOut.
 */
export function fusionMinAmountOut(
  json: FusionQuoteResponse,
  expectedOut: string,
): string | undefined {
  const presets = json.presets;
  if (!presets) return undefined;
  const rec = json.recommendedPreset ?? json.recommended_preset;
  const preset = (isPresetName(rec) ? presets[rec] : undefined)
    ?? presets.fast
    ?? presets.medium
    ?? presets.slow
    ?? presets.custom;
  const end = parsePositiveAmount(preset?.auctionEndAmount);
  const expected = parsePositiveAmount(expectedOut);
  if (end == null || expected == null || end >= expected) return undefined;
  return end.toString();
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  slippageBps?: number;
}): Promise<NormalizedQuote> {
  const {
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals,
    tokenOutDecimals,
    slippageBps,
  } = params;

  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — Fusion's settlement unwraps WETH → ETH
  // when dst == NATIVE_SENTINEL via post-interaction. Pass through.

  if (!FUSION_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("fusion", chain.displayName);
  }

  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("fusion", "ONEINCH_API_KEY");

  // Use a placeholder walletAddress for the quote-only path. Build()
  // re-queries with the real sender since the order's maker is bound to
  // the signer.
  const walletForQuote = "0x000000000000000000000000000000000000dEaD";

  const url = new URL(
    `https://api.1inch.dev/fusion/quoter/v2.0/${chain.chainId}/quote/receive`,
  );
  url.searchParams.set("fromTokenAddress", tokenIn);
  url.searchParams.set("toTokenAddress", tokenOut);
  url.searchParams.set("amount", amountIn.toString());
  url.searchParams.set("walletAddress", walletForQuote);
  url.searchParams.set("enableEstimate", "true");
  url.searchParams.set("source", referralSource());

  // Fusion's `fee` is basis points (QuoterRequest.build() serialises the raw
  // Bps value), unlike classic 1inch's percent.
  const feeBps = fusionFeeBps();
  if (feeBps > 0) url.searchParams.set("fee", String(feeBps));
  // Same unit as classic 1inch: percent. Quote and createOrder must send the
  // same value — otherwise the ranked floor and the signed takingAmount diverge.
  const slippagePct =
    slippageBps === undefined ? undefined : fusionSlippagePercent(slippageBps);
  if (slippagePct !== undefined) url.searchParams.set("slippage", String(slippagePct));

  const res = await venueFetch(url.toString(), {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
  });
  const json = await parseJsonOrWarn<FusionQuoteResponse>(res, "fusion /quote/receive");
  if (!res.ok || !json.toTokenAmount) {
    const reason = json.description ?? json.error ?? `${res.status} ${res.statusText}`;
    throw new Error(`fusion: ${reason}`);
  }

  const hops: NormalizedHop[] = []; // Fusion doesn't expose hops at quote time.

  // prices.usd carries PER-TOKEN spot prices, not whole-amount values —
  // scale by the human amounts so the renderer's USD/price-impact math
  // lines up with the other venues.
  const amountInStr = json.fromTokenAmount ?? amountIn.toString();
  const inPx = toNumOrNull(json.prices?.usd?.fromToken);
  const outPx = toNumOrNull(json.prices?.usd?.toToken);
  const humanIn = Number(amountInStr) / 10 ** tokenInDecimals;
  const humanOut = Number(json.toTokenAmount) / 10 ** tokenOutDecimals;

  const minAmountOut = fusionMinAmountOut(json, json.toTokenAmount);

  return {
    venue: "fusion",
    amountIn: amountInStr,
    amountOut: json.toTokenAmount,
    ...(minAmountOut ? { minAmountOut } : {}),
    amountInUsd: inPx != null && Number.isFinite(humanIn) ? inPx * humanIn : null,
    amountOutUsd: outPx != null && Number.isFinite(humanOut) ? outPx * humanOut : null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: json.settlementAddress ?? fusionSettlementFallback(chain.chainId),
    hops,
    tokenHints: new Map(),
    raw: json,
  };
}

// Deep-convert bigints to decimal strings. The fusion-sdk's EIP-712 object
// values are typed `string | bigint | number`; JSON.stringify chokes on
// bigint, and our wire shapes (Payload, --json) are JSON.
function jsonSafe<T>(value: unknown): T {
  if (typeof value === "bigint") return value.toString() as T;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out as T;
  }
  return value as T;
}

// Minimal fetch-backed HttpProviderConnector — the SDK defaults to axios,
// but native fetch is the house style and one less dep to bundle.
function fetchConnector(authKey: string) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: `Bearer ${authKey}`,
  };
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await venueFetch(url, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      let reason = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { description?: string; error?: string; message?: string };
        reason = j.description ?? j.message ?? j.error ?? reason;
      } catch {
        // not JSON — keep the raw text slice
      }
      throw new Error(`fusion build: ${url} → ${res.status} ${res.statusText}: ${reason}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return {
    get: <T>(url: string) => request<T>(url),
    post: <T>(url: string, data: unknown) =>
      request<T>(url, { method: "POST", body: JSON.stringify(data) }),
  };
}

export async function buildOrder(
  params: BuildTxParams,
): Promise<NormalizedOrder> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;

  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — settlement unwraps WETH → ETH at fill.

  if (!FUSION_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("fusion", chain.displayName);
  }
  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("fusion", "ONEINCH_API_KEY");

  // Lazy import — the SDK (plus its limit-order-sdk dep) is only needed on
  // the build path; quote stays on the lightweight raw-fetch adapter.
  const { FusionSDK, Address, Bps } = await import("@1inch/fusion-sdk");

  const maker = toChecksumAddress(sender);
  const sdk = new FusionSDK({
    url: "https://api.1inch.dev/fusion",
    network: chain.chainId,
    authKey: apiKey,
    httpProvider: fetchConnector(apiKey),
  });

  // createOrder re-quotes with the real maker (the order's `maker` field is
  // bound to the signer) and wraps the recommended auction preset into a
  // Limit Order Protocol v4 struct + the Fusion extension blob.
  const feeBps = fusionFeeBps();
  const slippagePct = fusionSlippagePercent(slippageBps);
  const prepared = await sdk.createOrder({
    fromTokenAddress: tokenIn,
    toTokenAddress: tokenOut,
    amount: amountIn.toString(),
    walletAddress: maker,
    source: referralSource(),
    ...(slippagePct !== undefined ? { slippage: slippagePct } : {}),
    ...(feeBps > 0
      ? {
          integratorFee: {
            receiver: new Address(getReferralConfig().address!),
            value: new Bps(BigInt(feeBps)),
          },
        }
      : {}),
  });

  const typedData = jsonSafe<Eip712TypedData>(
    prepared.order.getTypedData(chain.chainId),
  );

  // Relayer body — RelayerRequest shape: {order, signature, quoteId,
  // extension}. The signature slot is filled by the caller after signing.
  const bodyTemplate: Record<string, unknown> = {
    order: jsonSafe<Record<string, unknown>>(prepared.order.build()),
    signature: null,
    quoteId: prepared.quoteId,
    extension: prepared.order.extension.encode(),
  };

  return {
    kind: "order",
    venue: "fusion",
    // The maker's funds are pulled by the Limit Order Protocol v4 router —
    // the typed data's verifyingContract — not the settlement extension.
    spender: String(typedData.domain.verifyingContract),
    signer: maker,
    typedData,
    submit: {
      url: `https://api.1inch.dev/fusion/relayer/v2.0/${chain.chainId}/order/submit`,
      method: "POST",
      bodyTemplate,
      auth: { kind: "bearer", envVar: "ONEINCH_API_KEY" },
    },
    orderHash: prepared.hash,
    validUntilSec: Number(prepared.order.deadline),
    decayStartSec: Number(prepared.order.auctionStartTime),
    chainId: chain.chainId,
  };
}

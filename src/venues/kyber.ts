import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
} from "./types.ts";
import { UnsupportedChainError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, readTextOrWarn, venueFetch } from "./http.ts";
import { getReferralConfig } from "../referral.ts";

// Public, keyless host. Rate limited (3 rps per x-client-id as of 2026-09).
const KYBER_PUBLIC_BASE = "https://aggregator-api.kyberswap.com";
// API gateway (higher limits, `X-Api-Key` issued by KyberSwap BD —
// business@kyber.network). The docs only publish the base; the path suffix
// is assumed to mirror the public host and can be overridden with
// KYBER_API_BASE if it turns out to differ.
const KYBER_GATEWAY_BASE = "https://api.kyberswap.com/swap";

type KyberConfig = {
  /** Base URL, no trailing slash. Gateway when an API key is set. */
  base: string;
  apiKey: string | null;
  /** `source` on /route/build — recorded on-chain in the ClientData event. */
  source: string | null;
  /** `referral` on /route/build — free-form code in the ClientData event. */
  referral: string | null;
};

// All four knobs are optional. With none of them set the requests are
// byte-for-byte what they were before the gateway/attribution support:
// public host, `x-client-id` only, no `source` / `referral` fields.
export function kyberConfig(): KyberConfig {
  const apiKey = process.env.KYBER_API_KEY?.trim() || null;
  const rawBase = process.env.KYBER_API_BASE?.trim();
  let base = (rawBase || (apiKey ? KYBER_GATEWAY_BASE : KYBER_PUBLIC_BASE)).replace(/\/+$/, "");
  // Gateway requires a key; a baked KYBER_API_BASE without one 401s.
  if (!apiKey && base === KYBER_GATEWAY_BASE) base = KYBER_PUBLIC_BASE;
  return {
    base,
    apiKey,
    source: process.env.KYBER_SOURCE?.trim() || null,
    referral: process.env.KYBER_REFERRAL?.trim() || null,
  };
}

function kyberHeaders(cfg: KyberConfig, clientId: string): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", "x-client-id": clientId };
  if (cfg.apiKey) h["X-Api-Key"] = cfg.apiKey;
  return h;
}

type KyberRoutesResponse = {
  code: number;
  message: string;
  data?: {
    routeSummary: {
      tokenIn: string;
      amountIn: string;
      amountInUsd: string;
      tokenOut: string;
      amountOut: string;
      amountOutUsd: string;
      gas: string;
      gasPrice: string;
      gasUsd: string;
      extraFee?: {
        feeAmount: string;
        chargeFeeBy: "" | "currency_in" | "currency_out";
        isInBps: boolean;
        feeReceiver: string;
      };
      route: Array<
        Array<{
          pool: string;
          tokenIn: string;
          tokenOut: string;
          swapAmount: string;
          amountOut: string;
          exchange: string;
          poolType: string;
          poolExtra?: {
            swapFee?: number;
            fee?: number;
          } | null;
        }>
      >;
    };
    routerAddress: string;
  };
};

// Kyber ignores feeReceiver unless feeAmount, isInBps, and chargeFeeBy
// are set with it. feeAmount 0 registers the receiver and leaves
// amountOut unchanged. Empty chargeFeeBy is HTTP 400. Quote and build
// send the same quartet because /routes locks amountOut in routeSummary.
function kyberPartnerFee(ref: { address: string | null; feeBps: number }): {
  feeAmount: string;
  chargeFeeBy: "currency_out";
  isInBps: true;
  feeReceiver: string;
} | null {
  if (!ref.address) return null;
  return {
    feeAmount: String(ref.feeBps),
    chargeFeeBy: "currency_out",
    isInBps: true,
    feeReceiver: ref.address,
  };
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn } = params;
  if (chain.kyberPath === null) {
    throw new UnsupportedChainError("kyber", chain.displayName);
  }

  const cfg = kyberConfig();
  const url = new URL(`${cfg.base}/${chain.kyberPath}/api/v1/routes`);
  url.searchParams.set("tokenIn", tokenIn);
  url.searchParams.set("tokenOut", tokenOut);
  url.searchParams.set("amountIn", amountIn.toString());
  url.searchParams.set("gasInclude", "true");

  const ref = getReferralConfig();
  const fee = kyberPartnerFee(ref);
  if (fee) {
    url.searchParams.set("feeAmount", fee.feeAmount);
    url.searchParams.set("chargeFeeBy", fee.chargeFeeBy);
    url.searchParams.set("isInBps", String(fee.isInBps));
    url.searchParams.set("feeReceiver", fee.feeReceiver);
  }
  const res = await venueFetch(url.toString(), { headers: kyberHeaders(cfg, ref.name) });

  if (!res.ok) {
    const body = await readTextOrWarn(res, "kyberswap /routes");
    throw new Error(
      `kyberswap ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }

  const json = (await res.json()) as KyberRoutesResponse;
  if (json.code !== 0 || !json.data) {
    throw new Error(`kyberswap error: ${json.message || `code ${json.code}`}`);
  }

  const s = json.data.routeSummary;
  const hops: NormalizedHop[] = [];
  for (const path of s.route) {
    for (const h of path) {
      const fee = h.poolExtra?.swapFee ?? h.poolExtra?.fee;
      hops.push({
        tokenIn: h.tokenIn.toLowerCase(),
        tokenOut: h.tokenOut.toLowerCase(),
        exchange: h.exchange,
        swapAmount: h.swapAmount,
        amountOut: h.amountOut,
        pool: h.pool,
        fee: typeof fee === "number" ? fee : undefined,
      });
    }
  }

  return {
    venue: "kyber",
    amountIn: s.amountIn,
    amountOut: s.amountOut,
    amountInUsd: toNumOrNull(s.amountInUsd),
    amountOutUsd: toNumOrNull(s.amountOutUsd),
    gasUnits: toNumOrNull(s.gas),
    gasPriceWei: s.gasPrice || null,
    gasUsd: toNumOrNull(s.gasUsd),
    router: json.data.routerAddress,
    hops,
    tokenHints: new Map(),
    protocolFee: parseKyberExtraFee(s.extraFee, s.amountIn, s.amountOut),
    raw: json.data,
  };
}

function parseKyberExtraFee(
  extra: { feeAmount: string; chargeFeeBy: string; isInBps: boolean } | undefined,
  amountIn: string,
  amountOut: string,
): { raw: string; sharePct: number; side: "in" | "out" } | null {
  if (!extra || !extra.feeAmount || !extra.chargeFeeBy) return null;
  const side: "in" | "out" =
    extra.chargeFeeBy === "currency_in" ? "in" : "out";
  const base = side === "in" ? BigInt(amountIn) : BigInt(amountOut);
  let raw: bigint;
  if (extra.isInBps) {
    // feeAmount is bps; resolve against the relevant side's amount.
    raw = (base * BigInt(extra.feeAmount)) / 10_000n;
  } else {
    raw = BigInt(extra.feeAmount);
  }
  if (raw <= 0n) return null;
  const sharePct =
    base > 0n ? Number((raw * 100_000_000n) / base) / 1_000_000 : 0;
  return { raw: raw.toString(), sharePct, side };
}

type KyberBuildResponse = {
  code: number;
  message: string;
  data?: {
    amountIn: string;
    amountOut: string;
    gas: string;
    gasUsd: string;
    data: string;
    routerAddress: string;
  };
};

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, sender, slippageBps, quote } = params;
  if (chain.kyberPath === null) {
    throw new UnsupportedChainError("kyber", chain.displayName);
  }

  const rawData = quote.raw as { routeSummary?: unknown; routerAddress?: string } | undefined;
  if (!rawData?.routeSummary) {
    throw new Error("kyber: cannot build tx — quote.raw missing routeSummary");
  }

  const ref = getReferralConfig();
  const buildBody: Record<string, unknown> = {
    routeSummary: rawData.routeSummary,
    sender,
    recipient: sender,
    slippageTolerance: slippageBps,
    enableGasEstimation: false,
  };
  const fee = kyberPartnerFee(ref);
  if (fee) {
    buildBody.feeAmount = fee.feeAmount;
    buildBody.chargeFeeBy = fee.chargeFeeBy;
    buildBody.isInBps = fee.isInBps;
    buildBody.feeReceiver = fee.feeReceiver;
  }
  // On-chain attribution (ClientData event). Pure metadata: never changes
  // the route or the amounts, so it stays on under --nofee.
  const cfg = kyberConfig();
  if (cfg.source) buildBody.source = cfg.source;
  if (cfg.referral) buildBody.referral = cfg.referral;

  const url = `${cfg.base}/${chain.kyberPath}/api/v1/route/build`;
  const res = await venueFetch(url, {
    method: "POST",
    headers: { ...kyberHeaders(cfg, ref.name), "content-type": "application/json" },
    body: JSON.stringify(buildBody),
  });

  const json = await parseJsonOrWarn<KyberBuildResponse>(res, "kyberswap /route/build");
  if (!res.ok || json.code !== 0 || !json.data) {
    throw new Error(`kyber build: ${json.message || `${res.status} ${res.statusText}`}`);
  }

  return {
    to: json.data.routerAddress,
    from: sender,
    data: json.data.data,
    value: isNativeSend(params) ? params.amountIn.toString() : "0",
    gas: json.data.gas,
    gasPrice: quote.gasPriceWei,
    maxPriorityFeePerGas: null,
    spender: json.data.routerAddress,
    chainId: chain.chainId,
  };
}

function isNativeSend(params: BuildTxParams): boolean {
  return params.tokenIn.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

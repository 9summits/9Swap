import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  TokenHint,
} from "./types.ts";
import { UnsupportedChainError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { getReferralConfig } from "../referral.ts";

const ODOS_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 130, 137, 146, 250, 324, 8453, 34443, 42161, 43114, 59144, 534352,
  5000,
]);

const ODOS_NATIVE = "0x0000000000000000000000000000000000000000";

// Odos API V3 — replaces V2 (V2 is being retired by Odos). The free
// public endpoint at api.odos.xyz/sor/quote/v3 works without an API
// key but silently *ignores* `partnerFeePercent` / `feeRecipient` —
// monetization only applies on the enterprise tier. When the user
// sets ODOS_API_KEY in their .env, we route through
// enterprise-api.odos.xyz (where fees are honored). Auth header is
// `x-api-key: <key>` — verified via curl probe against the live API
// (Authorization: Bearer is silently ignored and produces a
// misleading "No API key provided" 403).
const ODOS_PUBLIC_BASE = "https://api.odos.xyz";
const ODOS_ENTERPRISE_BASE = "https://enterprise-api.odos.xyz";

function odosBase(): string {
  return process.env.ODOS_API_KEY ? ODOS_ENTERPRISE_BASE : ODOS_PUBLIC_BASE;
}

// --disableodosrfq toggle: when true, both quote and build send
// `disableRFQs: true`. Default is `false` (RFQ enabled). Some tokens
// (e.g. FXN) trip a 500 errorCode 2999 inside Odos's RFQ path; setting
// this lets the user dodge the broken codepath.
let disableRfqs = false;
export function setOdosDisableRfqs(v: boolean): void {
  disableRfqs = v;
}

function odosHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const key = process.env.ODOS_API_KEY;
  if (key) headers["x-api-key"] = key;
  return headers;
}

type OdosNode = {
  name: string;
  symbol: string;
  decimals: number;
};

type OdosLink = {
  source: number;
  target: number;
  label: string;
  value?: number;
  in_value?: number;
  out_value?: number;
  sourceToken?: { symbol: string; name: string; decimals: number };
  targetToken?: { symbol: string; name: string; decimals: number };
};

type OdosQuoteResponse = {
  inTokens?: string[];
  outTokens?: string[];
  inAmounts?: string[];
  outAmounts?: string[];
  gasEstimate?: number;
  gweiPerGas?: number;
  gasEstimateValue?: number;
  inValues?: number[];
  outValues?: number[];
  pathId?: string;
  pathViz?: {
    nodes: OdosNode[];
    links: OdosLink[];
  };
  // Integrator-configurable fee in percent (e.g. 0.5 = 0.5%). Default 0.
  // Odos applies the fee to the OUTPUT side.
  partnerFeePercent?: number;
  detail?: string;
};

function toOdosAddr(addr: string): string {
  return addr.toLowerCase() === NATIVE_SENTINEL ? ODOS_NATIVE : addr.toLowerCase();
}

function fromOdosAddr(addr: string): string {
  return addr.toLowerCase() === ODOS_NATIVE ? NATIVE_SENTINEL : addr.toLowerCase();
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
  /** Per-request override of the CLI module flag (dApp / serverless). */
  disableOdosRfq?: boolean;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn, slippageBps } = params;
  // Prefer per-request flag (dApp); fall back to the CLI module toggle.
  const noRfq = params.disableOdosRfq ?? disableRfqs;

  if (!ODOS_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("odos", chain.displayName);
  }

  const ref = getReferralConfig();
  const body: Record<string, unknown> = {
    chainId: chain.chainId,
    inputTokens: [{ tokenAddress: toOdosAddr(tokenIn), amount: amountIn.toString() }],
    outputTokens: [{ tokenAddress: toOdosAddr(tokenOut), proportion: 1 }],
    slippageLimitPercent: slippageBps / 100,
    compact: false,
    pathViz: true,
    sourceBlacklist: [] as string[],
    sourceWhitelist: [] as string[],
    disableRFQs: noRfq,
  };
  // V3 monetization: partnerFeePercent (in percent, e.g. 0.5 = 0.5%)
  // + feeRecipient (the partner address that receives 80% of the
  // collected fee, with 20% retained by Odos). Replaces V2's
  // referralCode mechanism. Only honored on enterprise-api.odos.xyz
  // (i.e. when ODOS_API_KEY is set); the public endpoint accepts the
  // fields but ignores them.
  if (ref.address && ref.feeBps > 0) {
    body.partnerFeePercent = ref.feeBps / 100;
    body.feeRecipient = ref.address;
  }

  const res = await venueFetch(`${odosBase()}/sor/quote/v3`, {
    method: "POST",
    headers: odosHeaders(),
    body: JSON.stringify(body),
  });

  const json = await parseJsonOrWarn<OdosQuoteResponse>(res, "odos /sor/quote/v3");
  if (!res.ok) {
    const reason = json.detail || `${res.status} ${res.statusText}`;
    if (res.status === 403 && process.env.ODOS_API_KEY) {
      throw new Error(
        `odos ${reason} — ODOS_API_KEY appears invalid for ` +
          `enterprise-api.odos.xyz. Either fix the key (or rotate at ` +
          `Odos's dashboard) or unset ODOS_API_KEY to fall back to the ` +
          `free public endpoint (no fees collected, but quotes work).`,
      );
    }
    throw new Error(`odos ${reason}`);
  }

  const inAmount = json.inAmounts?.[0] ?? amountIn.toString();
  const outAmount = json.outAmounts?.[0];
  if (!outAmount) {
    throw new Error(`odos: no outAmount in response`);
  }

  const inTokenAddr = json.inTokens?.[0]
    ? fromOdosAddr(json.inTokens[0])
    : tokenIn.toLowerCase();
  const outTokenAddr = json.outTokens?.[0]
    ? fromOdosAddr(json.outTokens[0])
    : tokenOut.toLowerCase();

  const nodes = json.pathViz?.nodes ?? [];
  const links = json.pathViz?.links ?? [];

  const tokenHints = new Map<string, TokenHint>();

  // Odos pathViz doesn't expose per-node addresses. We know source + target
  // addresses from the request; everything else stays as a positional unknown.
  // We still collect symbol hints from sourceToken / targetToken in links, but
  // we only pin them to addresses at the endpoints we know.
  for (const n of nodes) {
    void n;
  }

  type NodeAddr = { addr: string; known: boolean };
  const nodeAddrs: NodeAddr[] = nodes.map((n, i) => {
    if (i === 0) return { addr: inTokenAddr, known: true };
    if (i === nodes.length - 1) return { addr: outTokenAddr, known: true };
    return { addr: `unknown:${n.symbol}:${i}`, known: false };
  });

  // Attach token hints for known endpoints.
  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  if (firstNode) {
    tokenHints.set(inTokenAddr, {
      symbol: firstNode.symbol,
      name: firstNode.name,
      decimals: firstNode.decimals,
    });
  }
  if (lastNode) {
    tokenHints.set(outTokenAddr, {
      symbol: lastNode.symbol,
      name: lastNode.name,
      decimals: lastNode.decimals,
    });
  }

  const hops: NormalizedHop[] = [];
  for (const link of links) {
    const src = nodeAddrs[link.source];
    const tgt = nodeAddrs[link.target];
    const srcNode = nodes[link.source];
    if (!src || !tgt || !srcNode) continue;

    const humanIn = link.in_value ?? 0;
    const swapAmount = BigInt(Math.round(humanIn * 10 ** srcNode.decimals)).toString();
    const tgtNode = nodes[link.target];
    const amountOut =
      link.out_value != null && tgtNode
        ? BigInt(Math.round(link.out_value * 10 ** tgtNode.decimals)).toString()
        : undefined;

    hops.push({
      tokenIn: src.addr,
      tokenOut: tgt.addr,
      exchange: link.label,
      swapAmount,
      amountOut,
    });

    if (link.sourceToken && !tokenHints.has(src.addr)) {
      tokenHints.set(src.addr, {
        symbol: link.sourceToken.symbol,
        name: link.sourceToken.name,
        decimals: link.sourceToken.decimals,
      });
    }
    if (link.targetToken && !tokenHints.has(tgt.addr)) {
      tokenHints.set(tgt.addr, {
        symbol: link.targetToken.symbol,
        name: link.targetToken.name,
        decimals: link.targetToken.decimals,
      });
    }
  }

  const gasPriceWei = json.gweiPerGas
    ? BigInt(Math.round(json.gweiPerGas * 1e9)).toString()
    : null;

  // Odos surfaces an integrator fee as a % of the OUTPUT side. Without a
  // partner code (we never set one), this is 0.
  let protocolFee:
    | { raw: string; sharePct: number; side: "in" | "out" }
    | null = null;
  if (json.partnerFeePercent && json.partnerFeePercent > 0 && outAmount) {
    const out = BigInt(outAmount);
    // Convert percent → bp-precision integer to keep bigint math safe.
    const bp = BigInt(Math.round(json.partnerFeePercent * 100));
    const fee = (out * bp) / 10_000n;
    if (fee > 0n) {
      protocolFee = {
        raw: fee.toString(),
        sharePct: json.partnerFeePercent,
        side: "out",
      };
    }
  }

  return {
    venue: "odos",
    amountIn: inAmount,
    amountOut: outAmount,
    amountInUsd: toNumOrNull(json.inValues?.[0]),
    amountOutUsd: toNumOrNull(json.outValues?.[0]),
    gasUnits: toNumOrNull(json.gasEstimate),
    gasPriceWei,
    gasUsd: toNumOrNull(json.gasEstimateValue),
    router: null,
    hops,
    tokenHints,
    protocolFee,
    raw: json,
  };
}

// V3 combined quote+assemble — replaces V2's two-call flow (/quote +
// /assemble). The /sor/assemble endpoint only accepts V2 pathIds and
// errors with code 3110 ("Error assembling transaction") on V3 pathIds,
// so we use /sor/swap/v3 which takes the same request body as
// /sor/quote/v3 and returns {quote, assembly} where assembly.transaction
// is the executable tx.
type OdosSwapV3Response = {
  quote?: OdosQuoteResponse;
  assembly?: {
    transaction?: {
      to: string;
      from?: string;
      data: string;
      value: string | number;
      gas?: number | string;
      gasPrice?: number | string;
      chainId?: number;
      nonce?: number;
    };
  };
  detail?: string;
};

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;
  // Prefer per-request flag (dApp); fall back to the CLI module toggle.
  const noRfq = params.disableOdosRfq ?? disableRfqs;

  const ref = getReferralConfig();
  const swapBody: Record<string, unknown> = {
    chainId: chain.chainId,
    inputTokens: [{ tokenAddress: toOdosAddr(tokenIn), amount: amountIn.toString() }],
    outputTokens: [{ tokenAddress: toOdosAddr(tokenOut), proportion: 1 }],
    slippageLimitPercent: slippageBps / 100,
    userAddr: sender,
    compact: true,
    disableRFQs: noRfq,
  };
  if (ref.address && ref.feeBps > 0) {
    swapBody.partnerFeePercent = ref.feeBps / 100;
    swapBody.feeRecipient = ref.address;
  }

  const res = await venueFetch(`${odosBase()}/sor/swap/v3`, {
    method: "POST",
    headers: odosHeaders(),
    body: JSON.stringify(swapBody),
  });

  const json = await parseJsonOrWarn<OdosSwapV3Response>(res, "odos /sor/swap/v3");
  if (!res.ok || !json.assembly?.transaction) {
    throw new Error(
      `odos /sor/swap/v3: ${json.detail || `${res.status} ${res.statusText}`}`,
    );
  }

  const tx = json.assembly.transaction;
  return {
    to: tx.to,
    from: tx.from ?? sender,
    data: tx.data,
    value: String(tx.value),
    gas: tx.gas !== undefined ? String(tx.gas) : null,
    gasPrice: tx.gasPrice !== undefined ? String(tx.gasPrice) : null,
    maxPriorityFeePerGas: null,
    spender: tx.to,
    chainId: tx.chainId ?? chain.chainId,
  };
}

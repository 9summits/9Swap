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

// Legacy Odos API V2 adapter — deliberately kept alongside `odos` (which
// is now V3) because V2 occasionally returns better quotes for pairs
// where V3's protocol-fee-aware routing collapses small-edge paths.
// Same response shape as V3, same /sor/assemble endpoint for tx build,
// but uses the V2-only `referralCode` mechanism (ODOS_REFERRAL_CODE)
// instead of V3's `partnerFeePercent` + `feeRecipient`.

const ODOS_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 130, 137, 146, 250, 324, 8453, 34443, 42161, 43114, 59144, 534352,
  5000,
]);

const ODOS_NATIVE = "0x0000000000000000000000000000000000000000";

// Odos `referralCode` is registered per-chain at code-creation time on
// their portal. Sending a code that isn't registered on the requested
// chain trips `400 Invalid or unregistered referral code`. We only
// register `ODOS_REFERRAL_CODE` against mainnet, so suppress it
// elsewhere (the V2 API treats 0 as "no referral").
function effectiveOdosCode(code: number, chainId: number): number {
  return chainId === 1 ? code : 0;
}

// --odosnotcompact toggle: force `compact: false` on the build-side
// re-quote (the quote() path is already compact:false). Set from
// index.ts before any venue call runs.
let noCompact = false;
export function setOdosV2NoCompact(v: boolean): void {
  noCompact = v;
}

// --disableodosrfq toggle: when true, both quote and build send
// `disableRFQs: true`. Default is `false`. Mirrors the odos V3 adapter.
let disableRfqs = false;
export function setOdosV2DisableRfqs(v: boolean): void {
  disableRfqs = v;
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
    throw new UnsupportedChainError("odosv2", chain.displayName);
  }

  const ref = getReferralConfig();
  const body = {
    chainId: chain.chainId,
    inputTokens: [{ tokenAddress: toOdosAddr(tokenIn), amount: amountIn.toString() }],
    outputTokens: [{ tokenAddress: toOdosAddr(tokenOut), proportion: 1 }],
    slippageLimitPercent: slippageBps / 100,
    referralCode: effectiveOdosCode(ref.odosCode, chain.chainId),
    compact: false,
    pathViz: true,
    sourceBlacklist: [] as string[],
    sourceWhitelist: [] as string[],
    disableRFQs: noRfq,
  };

  const res = await venueFetch("https://api.odos.xyz/sor/quote/v2", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  const json = await parseJsonOrWarn<OdosQuoteResponse>(res, "odosv2 /sor/quote/v2");
  if (!res.ok) {
    throw new Error(
      `odosv2 ${res.status} ${res.statusText}${json.detail ? ` — ${json.detail}` : ""}`,
    );
  }

  const inAmount = json.inAmounts?.[0] ?? amountIn.toString();
  const outAmount = json.outAmounts?.[0];
  if (!outAmount) {
    throw new Error(`odosv2: no outAmount in response`);
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

  type NodeAddr = { addr: string; known: boolean };
  const nodeAddrs: NodeAddr[] = nodes.map((n, i) => {
    if (i === 0) return { addr: inTokenAddr, known: true };
    if (i === nodes.length - 1) return { addr: outTokenAddr, known: true };
    return { addr: `unknown:${n.symbol}:${i}`, known: false };
  });

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

    hops.push({
      tokenIn: src.addr,
      tokenOut: tgt.addr,
      exchange: link.label,
      swapAmount,
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

  let protocolFee:
    | { raw: string; sharePct: number; side: "in" | "out" }
    | null = null;
  if (json.partnerFeePercent && json.partnerFeePercent > 0 && outAmount) {
    const out = BigInt(outAmount);
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
    venue: "odosv2",
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

type OdosAssembleResponse = {
  transaction?: {
    to: string;
    from?: string;
    data: string;
    value: string;
    gas?: number | string;
    gasPrice?: number | string;
    chainId?: number;
  };
  detail?: string;
};

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;
  // Prefer per-request flag (dApp /api/build); fall back to the CLI module
  // toggle set via setOdosV2NoCompact(--odosnotcompact).
  const forceNoCompact = params.odosNotCompact ?? noCompact;
  // Prefer per-request flag (dApp); fall back to the CLI module toggle.
  const noRfq = params.disableOdosRfq ?? disableRfqs;

  const ref = getReferralConfig();
  // Odos binds pathId to userAddr, so we re-quote with the sender to get a
  // fresh pathId we can assemble.
  const quoteRes = await venueFetch("https://api.odos.xyz/sor/quote/v2", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      chainId: chain.chainId,
      inputTokens: [{ tokenAddress: toOdosAddr(tokenIn), amount: amountIn.toString() }],
      outputTokens: [{ tokenAddress: toOdosAddr(tokenOut), proportion: 1 }],
      slippageLimitPercent: slippageBps / 100,
      userAddr: sender,
      referralCode: effectiveOdosCode(ref.odosCode, chain.chainId),
      compact: !forceNoCompact,
      disableRFQs: noRfq,
    }),
  });
  const quoteJson = await parseJsonOrWarn<OdosQuoteResponse>(quoteRes, "odosv2 build-quote");
  if (!quoteRes.ok || !quoteJson.pathId) {
    throw new Error(
      `odosv2 build-quote: ${quoteJson.detail || `${quoteRes.status} ${quoteRes.statusText}`}`,
    );
  }

  const res = await venueFetch("https://api.odos.xyz/sor/assemble", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ userAddr: sender, pathId: quoteJson.pathId, simulate: false }),
  });

  const json = await parseJsonOrWarn<OdosAssembleResponse>(res, "odosv2 /sor/assemble");
  if (!res.ok || !json.transaction) {
    throw new Error(
      `odosv2 assemble: ${json.detail || `${res.status} ${res.statusText}`}`,
    );
  }

  const tx = json.transaction;
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

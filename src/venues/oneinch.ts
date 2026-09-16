import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
} from "./types.ts";
import { MissingApiKeyError, UnsupportedChainError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { getReferralConfig } from "../referral.ts";

// 1inch rejects `fee` above 3% with a hard 400 ("fee must not be greater
// than 3"), while REFERRAL_FEE_BPS allows up to 1000 — clamp like openocean
// does so a misconfiguration degrades the fee instead of dropping the venue.
const ONEINCH_FEE_BPS_MAX = 300;

const ONEINCH_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 100, 130, 137, 143, 250, 8453, 42161, 43114, 59144, 324, 146,
  // Robinhood (4663) — verified live 2026-07-02: /liquidity-sources lists
  // ROBINHOOD_* protocols and /quote returns real amounts.
  4663,
  // HyperEVM (999) — verified live 2026-09-10: /liquidity-sources lists
  // 13 HYPEREVM_* protocols (HyperSwap, Hybra, Curve Stable NG, KittenSwap,
  // Ramses, …) and /quote + /swap return real amounts / calldata.
  999,
  // Arc (5042) — verified live 2026-09-16: /quote + /swap answer and the API
  // returns Arc's own router (0xe08cab08…a6bda) as tx.to, which the adapter
  // already uses as the approval spender.
  5042,
]);

type OneinchProtocol = {
  name: string;
  part: number;
  fromTokenAddress: string;
  toTokenAddress: string;
};

type OneinchQuoteResponse = {
  dstAmount?: string;
  srcAmount?: string;
  gas?: number | string;
  protocols?: OneinchProtocol[][][];
  description?: string;
  error?: string;
  statusCode?: number;
};

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn } = params;

  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("1inch", "ONEINCH_API_KEY");

  if (!ONEINCH_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("1inch", chain.displayName);
  }

  const url = new URL(
    `https://api.1inch.dev/swap/v6.0/${chain.chainId}/quote`,
  );
  url.searchParams.set("src", tokenIn);
  url.searchParams.set("dst", tokenOut);
  url.searchParams.set("amount", amountIn.toString());
  url.searchParams.set("includeProtocols", "true");
  url.searchParams.set("includeGas", "true");

  // Mirror buildTx's referral params so /quote and /swap are always evaluated
  // under the same fee configuration (same contract as "same slippage for quote
  // and build"). Empirically, 1inch v6 ignores them on BOTH endpoints today —
  // see the note on buildTx — so this changes nothing until/unless 1inch starts
  // honouring partner fees for this key, at which point the displayed quote
  // becomes net automatically instead of silently drifting from the built tx.
  const ref = getReferralConfig();
  if (ref.address && ref.feeBps > 0) {
    url.searchParams.set("referrer", ref.address);
    url.searchParams.set(
      "fee",
      (Math.min(ref.feeBps, ONEINCH_FEE_BPS_MAX) / 100).toString(),
    );
  }

  const res = await venueFetch(url.toString(), {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });

  const json = await parseJsonOrWarn<OneinchQuoteResponse>(res, "1inch /quote");

  if (!res.ok) {
    const reason =
      json.description || json.error || `${res.status} ${res.statusText}`;
    throw new Error(`1inch: ${reason}`);
  }

  if (!json.dstAmount) {
    throw new Error(`1inch: missing dstAmount in response`);
  }

  const hops: NormalizedHop[] = [];
  const paths = json.protocols ?? [];
  for (const path of paths) {
    for (let li = 0; li < path.length; li++) {
      const level = path[li]!;
      const total = level.reduce((a, p) => a + (p.part || 0), 0);
      for (const p of level) {
        const share = total > 0 ? p.part / total : 1;
        const swap = BigInt(Math.round(Number(amountIn) * share)).toString();
        hops.push({
          tokenIn: p.fromTokenAddress.toLowerCase(),
          tokenOut: p.toTokenAddress.toLowerCase(),
          exchange: p.name,
          // Level 0 swaps real shares of amountIn; deeper levels swap an
          // intermediate token whose amount 1inch doesn't expose — `swap`
          // is then only a split weight in the input token's units.
          swapAmount: swap,
          approxAmount: li > 0 || undefined,
        });
      }
    }
  }

  return {
    venue: "1inch",
    amountIn: json.srcAmount ?? amountIn.toString(),
    amountOut: json.dstAmount,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: toNumOrNull(json.gas),
    gasPriceWei: null,
    gasUsd: null,
    router: null,
    hops,
    tokenHints: new Map(),
    raw: json,
  };
}

type OneinchSwapResponse = {
  tx?: {
    from: string;
    to: string;
    data: string;
    value: string;
    gas: number | string;
    gasPrice: string;
  };
  dstAmount?: string;
  description?: string;
  error?: string;
};

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;

  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("1inch", "ONEINCH_API_KEY");

  const url = new URL(
    `https://api.1inch.dev/swap/v6.0/${chain.chainId}/swap`,
  );
  url.searchParams.set("src", tokenIn);
  url.searchParams.set("dst", tokenOut);
  url.searchParams.set("amount", amountIn.toString());
  url.searchParams.set("from", sender);
  url.searchParams.set("slippage", (slippageBps / 100).toString());
  url.searchParams.set("disableEstimate", "true");

  const ref = getReferralConfig();
  if (ref.address && ref.feeBps > 0) {
    // 1inch takes `fee` as a percent string, clamped to ONEINCH_FEE_BPS_MAX.
    // 1inch keeps ~10% of whatever fee is set; the rest is meant to go to
    // `referrer`.
    //
    // Verified 2026-08-09 (v6.0, mainnet): 1inch accepts and validates both
    // params but does NOT apply the fee. The returned calldata is byte-identical
    // with and without them, the referrer address never appears in it, and an
    // eth_simulateV1 prank at fee=3% delivered *more* tokenOut than the gross
    // quote (0 bp of fee, no Transfer to REFERRAL_ADDRESS). So the displayed
    // quote is NOT gross-vs-net: nothing is deducted at execution either, and
    // we deliberately do not subtract anything in quote(). Re-measure before
    // wiring a protocolFee row — presumably the fee needs a 1inch business
    // plan / registered referrer to activate.
    url.searchParams.set("referrer", ref.address);
    url.searchParams.set(
      "fee",
      (Math.min(ref.feeBps, ONEINCH_FEE_BPS_MAX) / 100).toString(),
    );
  }

  const res = await venueFetch(url.toString(), {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });

  const json = await parseJsonOrWarn<OneinchSwapResponse>(res, "1inch /swap");
  if (!res.ok || !json.tx) {
    throw new Error(
      `1inch build: ${json.description || json.error || `${res.status} ${res.statusText}`}`,
    );
  }

  const tx = json.tx;
  return {
    to: tx.to,
    from: tx.from ?? sender,
    data: tx.data,
    value: String(tx.value),
    gas: String(tx.gas),
    gasPrice: tx.gasPrice,
    maxPriorityFeePerGas: null,
    spender: tx.to,
    chainId: chain.chainId,
  };
}

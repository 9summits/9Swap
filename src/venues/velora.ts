import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
} from "./types.ts";
import { UnsupportedChainError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { getReferralConfig } from "../referral.ts";

const VELORA_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 100, 137, 146, 250, 1101, 8453, 42161, 43114,
]);

/** Exact-in (sell) vs exact-out (buy). Maps to Velora /prices `side` SELL/BUY. */
export type VeloraSide = "sell" | "buy";

/**
 * Velora /prices `amount` param is denominated in the FIXED leg's token:
 * - SELL (exact-in): amount = srcToken amount (srcDecimals)
 * - BUY  (exact-out): amount = destToken amount (destDecimals)
 * The response always carries both srcAmount + destAmount; only which one is
 * fixed vs estimated flips. Verified live 2026-07-15 against api.velora.xyz
 * (BUY 0.5 WETH ← USDC → priceRoute.srcAmount ≈ 940e6, destAmount = 5e17).
 */
export function veloraPriceAmount(opts: {
  side: VeloraSide;
  amountIn?: bigint;
  amountOut?: bigint;
}): { side: "SELL" | "BUY"; amount: string } {
  if (opts.side === "buy") {
    if (opts.amountOut == null) throw new Error("velora: side=buy requires amountOut");
    return { side: "BUY", amount: opts.amountOut.toString() };
  }
  if (opts.amountIn == null) throw new Error("velora: side=sell requires amountIn");
  return { side: "SELL", amount: opts.amountIn.toString() };
}

/**
 * Velora /transactions fixes the FIXED leg and lets `slippage` (bps) bound the
 * estimated leg:
 * - SELL: srcAmount fixed → Velora floors destAmount at (1 - slippage)
 * - BUY:  destAmount fixed → Velora ceils srcAmount at (1 + slippage) = maxIn
 * Passing the fixed leg only (not the estimated one) keeps the build in sync
 * with the priceRoute. Verified live 2026-07-15 (BUY destAmount + slippage=50 →
 * HTTP 200 executable calldata).
 */
export function veloraBuildAmountFields(opts: {
  side: VeloraSide;
  amountIn?: bigint;
  amountOut?: bigint;
}): { srcAmount: string } | { destAmount: string } {
  if (opts.side === "buy") {
    if (opts.amountOut == null) throw new Error("velora: side=buy requires amountOut");
    return { destAmount: opts.amountOut.toString() };
  }
  if (opts.amountIn == null) throw new Error("velora: side=sell requires amountIn");
  return { srcAmount: opts.amountIn.toString() };
}

type VeloraSwapExchange = {
  exchange: string;
  srcAmount: string;
  destAmount: string;
  percent: number;
  poolAddresses?: string[];
  data?: {
    path?: Array<{ fee?: string | number; currentFee?: string | number }>;
    fee?: string | number;
  };
};

type VeloraSwap = {
  srcToken: string;
  srcDecimals: number;
  destToken: string;
  destDecimals: number;
  swapExchanges: VeloraSwapExchange[];
};

type VeloraRoute = {
  percent: number;
  swaps: VeloraSwap[];
};

type VeloraPricesResponse = {
  priceRoute?: {
    blockNumber: number;
    network: number;
    srcToken: string;
    srcDecimals: number;
    srcAmount: string;
    destToken: string;
    destDecimals: number;
    destAmount: string;
    // Velora deducts the partner fee from the OUTPUT side; both fields
    // are present only when an integrator fee is configured.
    destAmountAfterFee?: string;
    partnerFee?: number | null;
    partner?: string | null;
    bestRoute: VeloraRoute[];
    gasCost?: string;
    gasCostUSD?: string;
    srcUSD?: string;
    destUSD?: string;
    contractAddress?: string;
    tokenTransferProxy?: string;
  };
  error?: string;
};

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  /** Exact-out receive amount (side=buy). */
  amountOut?: bigint;
  /** Defaults to "sell" (exact-in) for back-compat with the amountIn pipeline. */
  side?: VeloraSide;
}): Promise<NormalizedQuote> {
  const {
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals,
    tokenOutDecimals,
  } = params;
  const side: VeloraSide = params.side ?? "sell";

  if (!VELORA_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("velora", chain.displayName);
  }

  // SELL fixes srcToken amount, BUY fixes destToken amount. srcDecimals /
  // destDecimals are always the true token decimals; only the `amount`
  // denomination flips with side (see veloraPriceAmount).
  const { side: apiSide, amount } = veloraPriceAmount({
    side,
    amountIn,
    amountOut: params.amountOut,
  });

  const url = new URL("https://api.velora.xyz/prices/");
  url.searchParams.set("srcToken", tokenIn);
  url.searchParams.set("destToken", tokenOut);
  url.searchParams.set("amount", amount);
  url.searchParams.set("srcDecimals", String(tokenInDecimals));
  url.searchParams.set("destDecimals", String(tokenOutDecimals));
  url.searchParams.set("side", apiSide);
  url.searchParams.set("network", String(chain.chainId));
  // Pin to Augustus V6.2. Without `version`, Velora's API still routes
  // through legacy Augustus V5 (`0xDEF171…FEe57`), whose `simpleSwap`
  // happily encodes the partner address into calldata but doesn't
  // actually execute the fee transfer at runtime — so the displayed
  // `protocolFee` row was correct but no on-chain Transfer ever fired.
  // V6.2 (`0x6a00…1068`, method `swapExactAmountIn`) does execute it.
  url.searchParams.set("version", "6.2");

  const ref = getReferralConfig();
  // partner is set unconditionally so requests are attributed even without
  // a referral address.
  url.searchParams.set("partner", ref.name);
  if (ref.address) {
    url.searchParams.set("partnerAddress", ref.address);
    // takeSurplus captures positive slippage; doesn't worsen displayed quote.
    url.searchParams.set("takeSurplus", "true");
    // Bypass Velora's Fee Claimer contract so the partner fee is
    // pushed directly to `partnerAddress` during the swap. Without
    // this, fees accrue in the protocol vault
    // (0x00700052c0608f670705380a4900e0a8080010cc) and the integrator
    // has to claim from Velora's portal periodically — which made
    // `--simulate --debug` show no fee transfer at all even though
    // the displayed `protocolFee` row was correct.
    // Source: developers.velora.xyz "Build Parameters for Transaction"
    url.searchParams.set("isDirectFeeTransfer", "true");
  }
  if (ref.feeBps > 0) {
    url.searchParams.set("partnerFeeBps", String(ref.feeBps));
  }

  const res = await venueFetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  const json = await parseJsonOrWarn<VeloraPricesResponse>(res, "velora /prices");

  if (!res.ok || !json.priceRoute) {
    throw new Error(
      `velora ${res.status} ${res.statusText}${json.error ? ` — ${json.error}` : ""}`,
    );
  }

  const pr = json.priceRoute;
  const hops: NormalizedHop[] = [];

  for (const route of pr.bestRoute) {
    for (const swap of route.swaps) {
      const srcLower = swap.srcToken.toLowerCase();
      const dstLower = swap.destToken.toLowerCase();
      for (const se of swap.swapExchanges) {
        const rawFee =
          se.data?.path?.[0]?.currentFee ??
          se.data?.path?.[0]?.fee ??
          se.data?.fee;
        const fee =
          rawFee !== undefined ? Number(rawFee) : undefined;
        hops.push({
          tokenIn: srcLower,
          tokenOut: dstLower,
          exchange: se.exchange,
          swapAmount: se.srcAmount,
          amountOut: se.destAmount,
          pool: se.poolAddresses?.[0],
          fee: Number.isFinite(fee) ? fee : undefined,
        });
      }
    }
  }

  // Velora's partner fee is expressed as `destAmount - destAmountAfterFee`
  // when applied (output side). With no `partner` query param we never see
  // this, but wire it through for completeness.
  let protocolFee:
    | { raw: string; sharePct: number; side: "in" | "out" }
    | null = null;
  if (pr.destAmountAfterFee) {
    const gross = BigInt(pr.destAmount);
    const net = BigInt(pr.destAmountAfterFee);
    const fee = gross - net;
    if (fee > 0n) {
      const sharePct =
        gross > 0n ? Number((fee * 100_000_000n) / gross) / 1_000_000 : 0;
      protocolFee = { raw: fee.toString(), sharePct, side: "out" };
    }
  }

  return {
    venue: "velora",
    amountIn: pr.srcAmount,
    amountOut: pr.destAmountAfterFee ?? pr.destAmount,
    amountInUsd: toNumOrNull(pr.srcUSD),
    amountOutUsd: toNumOrNull(pr.destUSD),
    gasUnits: toNumOrNull(pr.gasCost),
    gasPriceWei: null,
    gasUsd: toNumOrNull(pr.gasCostUSD),
    router: pr.contractAddress ?? null,
    hops,
    tokenHints: new Map(),
    protocolFee,
    raw: json,
  };
}

type VeloraBuildResponse = {
  from?: string;
  to?: string;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  error?: string;
};

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps, quote } = params;
  const side: VeloraSide = params.side ?? "sell";

  const priceRoute = (quote.raw as { priceRoute?: VeloraPricesResponse["priceRoute"] } | undefined)?.priceRoute;
  if (!priceRoute) {
    throw new Error("velora: cannot build tx — quote.raw missing priceRoute");
  }

  const url = new URL(`https://api.velora.xyz/transactions/${chain.chainId}`);
  url.searchParams.set("ignoreChecks", "true");
  url.searchParams.set("ignoreGasEstimate", "false");
  url.searchParams.set("ignoreAllowance", "true");

  const ref = getReferralConfig();
  // SELL fixes srcAmount; BUY fixes destAmount (= exact-out target) and lets
  // `slippage` ceil srcAmount to maxIn. The priceRoute (already side=BUY when
  // buy) is passed through untouched so Velora keeps the same route.
  const amountFields = veloraBuildAmountFields({
    side,
    amountIn,
    amountOut: params.amountOut,
  });
  const body: Record<string, unknown> = {
    srcToken: tokenIn,
    destToken: tokenOut,
    ...amountFields,
    slippage: slippageBps,
    priceRoute,
    userAddress: sender,
    partner: ref.name,
  };
  if (ref.address) {
    body.partnerAddress = ref.address;
    body.takeSurplus = true;
    // Same flag as on /prices — must be set on /transactions too,
    // otherwise the build call falls back to the vaulted-fee path.
    body.isDirectFeeTransfer = true;
    // Referral Program 2.0 attribution (off-chain only — calldata is
    // unchanged). Must be an address; shows up in Velora's "Referrers Txs"
    // Metabase card keyed by referrer_address.
    body.referrer = ref.address;
  }
  if (ref.feeBps > 0) body.partnerFeeBps = ref.feeBps;

  const res = await venueFetch(url.toString(), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await parseJsonOrWarn<VeloraBuildResponse>(res, "velora /transactions");
  if (!res.ok || !json.to || !json.data) {
    throw new Error(
      `velora build: ${json.error || `${res.status} ${res.statusText}`}`,
    );
  }

  return {
    to: json.to,
    from: json.from ?? sender,
    data: json.data,
    value: json.value ?? "0",
    gas: json.gas ?? null,
    gasPrice: json.gasPrice ?? null,
    maxPriorityFeePerGas: null,
    spender: priceRoute.tokenTransferProxy ?? json.to,
    chainId: chain.chainId,
  };
}

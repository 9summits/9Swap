import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  Eip712TypedData,
  NormalizedHop,
  NormalizedOrder,
  NormalizedQuote,
} from "./types.ts";
import { UnsupportedChainError, UnsupportedSideError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { toChecksumAddress } from "../checksum.ts";
import { getReferralConfig } from "../referral.ts";

// Velora Delta supports the same chains as classic Velora, modulo a few. We
// enumerate the ones the API confirmed (probed live): chainId numbers from
// the validator error message.
// Live /quote?mode=delta validator (2026-09-04) does not include 9745.
// Live /quote?mode=delta returns {errorType:"UnsupportedChain"} for 100
// (Gnosis) although the validator lists it — verified 2026-09-09. The
// sync velora venue does serve Gnosis.
const DELTA_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 130, 137, 146, 8453, 42161, 43114,
]);

// Default order validity. Fillers typically settle within a minute of
// signing; 5 minutes is a comfortable upper bound that lets the user copy
// the order out, sign with cast, and POST it without racing the deadline.
const DELTA_VALIDITY_SECONDS = 300;

function rejectIfNative(addr: string, role: "tokenIn" | "tokenOut"): void {
  if (addr.toLowerCase() === NATIVE_SENTINEL) {
    throw new Error(
      `delta does not support native ETH as ${role} — wrap to WETH (or the chain's wrapped native) and pass that address.`,
    );
  }
}

// Delta's intent auction only settles exact-in (SELL) orders — the API has no
// BUY/exact-out mode. Reject side=buy loudly so the dispatcher's buy path never
// silently returns a sell-shaped order. Defense-in-depth: the dispatcher also
// filters via BUY_CAPABLE_VENUES before calling here.
function rejectIfBuy(side: "sell" | "buy" | undefined): void {
  if (side === "buy") {
    throw new UnsupportedSideError("delta");
  }
}

type DeltaPriceObject = Record<string, unknown>;

type VeloraQuoteDeltaResponse = {
  delta?: DeltaPriceObject & {
    srcToken: string;
    destToken: string;
    srcAmount: string;
    destAmount: string;
    receivedDestAmount?: string;
    receivedDestUSD?: string;
    receivedDestAmountBeforeFee?: string;
    destAmountBeforeFee?: string;
    gasCost?: string;
    gasCostUSD?: string;
    srcUSD?: string;
    destUSD?: string;
    partner?: string;
    partnerFee?: number;
    hmac?: string;
  };
  deltaAddress?: string;
  details?: string;
  errorType?: string;
};

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  /** Delta is SELL-only; side=buy is rejected up front. */
  side?: "sell" | "buy";
}): Promise<NormalizedQuote> {
  const {
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals,
    tokenOutDecimals,
  } = params;

  rejectIfBuy(params.side);
  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — Delta's settlement unwraps WETH → ETH
  // when destToken == NATIVE_SENTINEL. Pass the sentinel through.

  if (!DELTA_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("delta", chain.displayName);
  }

  const url = new URL("https://api.velora.xyz/quote");
  url.searchParams.set("srcToken", tokenIn);
  url.searchParams.set("destToken", tokenOut);
  url.searchParams.set("amount", amountIn.toString());
  url.searchParams.set("srcDecimals", String(tokenInDecimals));
  url.searchParams.set("destDecimals", String(tokenOutDecimals));
  url.searchParams.set("side", "SELL"); // Delta is SELL-only.
  url.searchParams.set("chainId", String(chain.chainId));
  url.searchParams.set("mode", "delta");

  const ref = getReferralConfig();
  url.searchParams.set("partner", ref.name);
  if (ref.address) {
    url.searchParams.set("partnerAddress", ref.address);
  }
  if (ref.feeBps > 0) {
    url.searchParams.set("partnerFeeBps", String(ref.feeBps));
  }

  const res = await venueFetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  const json = await parseJsonOrWarn<VeloraQuoteDeltaResponse>(
    res,
    "delta /quote",
  );
  if (!res.ok || !json.delta) {
    const reason = json.details ?? json.errorType ?? `${res.status} ${res.statusText}`;
    throw new Error(`delta: ${reason}`);
  }

  const d = json.delta;

  // Delta does not expose hops — solver auction picks the path at fill.
  const hops: NormalizedHop[] = [];

  // Net amount the user actually receives (post fee). The "before fee"
  // variant is the gross; we display the net as the headline amountOut so
  // it matches what the order's `destAmount` minimum will be.
  const headlineOut = d.receivedDestAmount ?? d.destAmount;

  // Surface the explicit fee diff when both sides are present.
  let protocolFee:
    | { raw: string; sharePct: number; side: "in" | "out" }
    | null = null;
  if (d.destAmountBeforeFee && d.destAmount) {
    const gross = BigInt(d.destAmountBeforeFee);
    const net = BigInt(d.destAmount);
    const feeAmt = gross - net;
    if (feeAmt > 0n) {
      const sharePct =
        gross > 0n ? Number((feeAmt * 100_000_000n) / gross) / 1_000_000 : 0;
      protocolFee = { raw: feeAmt.toString(), sharePct, side: "out" };
    }
  }

  return {
    venue: "delta",
    amountIn: d.srcAmount,
    amountOut: headlineOut,
    amountInUsd: toNumOrNull(d.srcUSD),
    amountOutUsd: toNumOrNull(d.receivedDestUSD ?? d.destUSD),
    // Filler pays gas in Delta auctions — the API's gasCost is an internal
    // estimate that's not user-payable. Surfacing it would mislead users
    // comparing against sync venues. Render shows "gas filler" instead.
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: json.deltaAddress ?? null,
    hops,
    tokenHints: new Map(),
    protocolFee,
    raw: json,
  };
}

type DeltaBuildResponse = {
  toSign?: {
    domain: Record<string, string | number>;
    types: Record<string, Array<{ name: string; type: string }>>;
    value: Record<string, unknown>;
  };
  orderHash?: string;
  details?: string;
  errorType?: string;
};

export async function buildOrder(
  params: BuildTxParams,
): Promise<NormalizedOrder> {
  const {
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals,
    tokenOutDecimals,
    sender,
    slippageBps,
  } = params;

  rejectIfBuy(params.side);
  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — Delta's settlement unwraps WETH → ETH
  // when destToken == NATIVE_SENTINEL. Pass the sentinel through.

  // Velora's HMAC on the quote response is bound to the userAddress used
  // when fetching the quote. The quote-only path uses a placeholder, so
  // re-fetch here with the real sender to get a fresh, valid HMAC the
  // build endpoint accepts.
  const quoteUrl = new URL("https://api.velora.xyz/quote");
  quoteUrl.searchParams.set("srcToken", tokenIn);
  quoteUrl.searchParams.set("destToken", tokenOut);
  quoteUrl.searchParams.set("amount", amountIn.toString());
  quoteUrl.searchParams.set("srcDecimals", String(tokenInDecimals));
  quoteUrl.searchParams.set("destDecimals", String(tokenOutDecimals));
  quoteUrl.searchParams.set("side", "SELL");
  quoteUrl.searchParams.set("chainId", String(chain.chainId));
  quoteUrl.searchParams.set("mode", "delta");
  quoteUrl.searchParams.set("userAddress", toChecksumAddress(sender));
  const ref = getReferralConfig();
  quoteUrl.searchParams.set("partner", ref.name);
  if (ref.address) quoteUrl.searchParams.set("partnerAddress", ref.address);
  if (ref.feeBps > 0) quoteUrl.searchParams.set("partnerFeeBps", String(ref.feeBps));

  const qRes = await venueFetch(quoteUrl.toString(), {
    headers: { accept: "application/json" },
  });
  const raw = await parseJsonOrWarn<VeloraQuoteDeltaResponse>(
    qRes,
    "delta build /quote",
  );
  if (!qRes.ok || !raw.delta || !raw.deltaAddress) {
    const reason = raw.details ?? raw.errorType ?? `${qRes.status} ${qRes.statusText}`;
    throw new Error(`delta build: ${reason}`);
  }
  const d = raw.delta;
  const deltaAddress = toChecksumAddress(raw.deltaAddress);

  // Velora authenticates the build via the HMAC field embedded in the
  // quote response. Mutating any field of the `delta` payload invalidates
  // the HMAC, so we pass it through untouched and let the API enforce
  // slippage via the separate `slippage` (bps) parameter.
  const validUntilSec = Math.floor(Date.now() / 1000) + DELTA_VALIDITY_SECONDS;

  const buildBody: Record<string, unknown> = {
    chainId: chain.chainId,
    owner: toChecksumAddress(sender),
    beneficiary: toChecksumAddress(sender),
    deadline: validUntilSec,
    price: d,
    slippage: slippageBps,
  };

  const res = await venueFetch("https://api.velora.xyz/delta/orders/build", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(buildBody),
  });
  const json = await parseJsonOrWarn<DeltaBuildResponse>(
    res,
    "delta /delta/orders/build",
  );
  if (!res.ok || !json.toSign) {
    const reason = json.details ?? json.errorType ?? `${res.status} ${res.statusText}`;
    throw new Error(`delta build: ${reason}`);
  }

  const toSign = json.toSign;
  // Velora's response omits `primaryType`. The first key in `types` other
  // than EIP712Domain is the primary order type — for Delta that's "Order".
  const primaryType =
    Object.keys(toSign.types).find((k) => k !== "EIP712Domain") ?? "Order";

  const typedData: Eip712TypedData = {
    domain: toSign.domain,
    types: toSign.types,
    primaryType,
    message: toSign.value,
  };

  const submitBody: Record<string, unknown> = {
    chainId: chain.chainId,
    order: toSign.value,
    signature: null, // caller fills after signing
  };
  if (json.orderHash) submitBody.orderHash = json.orderHash;
  // Referral Program 2.0 attribution on the posted order (SDK
  // `SubmitDeltaOrderParams.referrerAddress`); off-chain only.
  if (ref.address) submitBody.referrerAddress = ref.address;

  return {
    kind: "order",
    venue: "delta",
    spender: deltaAddress,
    signer: toChecksumAddress(sender),
    typedData,
    submit: {
      url: "https://api.velora.xyz/delta/orders",
      method: "POST",
      bodyTemplate: submitBody,
    },
    validUntilSec,
    decayStartSec: null,
    chainId: chain.chainId,
  };
}

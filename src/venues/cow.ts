import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  Eip712TypedData,
  NormalizedHop,
  NormalizedOrder,
  NormalizedQuote,
} from "./types.ts";
import { UnsupportedChainError } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { toChecksumAddress } from "../checksum.ts";
import { getReferralConfig } from "../referral.ts";
import { maxAmountIn, minAmountOut } from "../slippage.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";

// CoW Protocol contracts — deterministic deploys, same address on every
// supported chain. Sourced from docs.cow.fi (verified against chain ids
// 1, 100, 8453, 42161 explorer; 137 + 57073 live 2026-09-09: settlement
// domainSeparator() eth_call and vault-relayer bytecode non-empty).
const GPV2_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
const GPV2_VAULT_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";

// Hash of the canonical empty appData "{}". Constant by definition, so it
// stays a literal instead of being re-derived on every quote.
const EMPTY_APP_DATA = "{}";
const EMPTY_APP_DATA_HASH =
  "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d";

// docs.cow.fi/governance/fees/partner-fee caps partner-program volume fees at
// 100 bps. The orderbook itself enforces no ceiling (measured: 500 and even
// 20000 bps quote fine), so this clamp is ours: it keeps us inside the program
// and keeps what we declare equal to what we deduct locally.
const COW_PARTNER_FEE_BPS_MAX = 100;

// CoW's quote endpoint requires a "from" — used for indicative pricing
// (allowance/balance hints). Sent only to the quote API; never embedded in
// a signed order. The build path requires a real sender (-d guard in
// index.ts) so the placeholder cannot leak into a tx.
const COW_QUOTE_PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";

const COW_NETWORK: Record<number, string> = {
  1: "mainnet",
  100: "xdai",
  137: "polygon",
  8453: "base",
  42161: "arbitrum_one",
  57073: "ink",
};

/** Exact-in (sell) vs exact-out (buy). Matches CoW order `kind`. */
export type CowSide = "sell" | "buy";

/** CIP-75 volume partner fee: a flat bps cut of the surplus-side token. */
type CowVolumePartnerFee = { volumeBps: number; recipient: string };

type CowAppDataDoc = {
  version: string;
  appCode: string;
  metadata: { referrer?: { code: string }; partnerFee?: CowVolumePartnerFee };
};

function networkFor(chain: ChainInfo): string {
  const net = COW_NETWORK[chain.chainId];
  if (!net) throw new UnsupportedChainError("cow", chain.displayName);
  return net;
}

// Build the order's appData document. CoW carries all attribution AND all
// revenue in this JSON doc (no header/param like other venues): the bytes32
// keccak of the EXACT string is what gets signed into the order (the `appData`
// field) and validated by the orderbook against the string sent in the POST
// body. We populate `metadata.referrer.code` from COW_REFERRAL_CODE (free CoW
// affiliate program), `metadata.partnerFee` from REFERRAL_ADDRESS /
// REFERRAL_FEE_BPS (CIP-75 volume fee, the paying one), and `appCode` from
// REFERRAL_NAME. Schema version 1.15.0 is the first line that references the
// code-based referrer (v1.14.0+); declaring an older version would validate
// `referrer.code` against the address-based schema. With neither configured we
// keep the canonical empty "{}" doc so the default order is byte-for-byte
// unchanged.
//
// `--nofee` zeroes feeBps in referral.ts, which drops the partnerFee key while
// leaving the free referrer code in place.
//
// The hash must be over the byte-identical string we send, so we serialize once
// and hash that exact output. Only quote() calls this: it sends the doc to
// /quote, and CoW echoes both `appData` (string) and `appDataHash` back in the
// response, which buildOrder() reuses verbatim — so the signed bytes32 and the
// submitted string stay consistent without re-deriving them.
export function buildCowAppData(): {
  appData: string;
  appDataHash: string;
  partnerFeeBps: number;
} {
  const { cowReferralCode, name, address, feeBps } = getReferralConfig();
  const partnerFeeBps =
    feeBps > 0 && address ? Math.min(feeBps, COW_PARTNER_FEE_BPS_MAX) : 0;

  if (!cowReferralCode && partnerFeeBps === 0) {
    return {
      appData: EMPTY_APP_DATA,
      appDataHash: EMPTY_APP_DATA_HASH,
      partnerFeeBps: 0,
    };
  }

  const metadata: CowAppDataDoc["metadata"] = {};
  if (cowReferralCode) metadata.referrer = { code: cowReferralCode };
  if (partnerFeeBps > 0 && address) {
    metadata.partnerFee = { volumeBps: partnerFeeBps, recipient: address };
  }
  const doc: CowAppDataDoc = {
    version: "1.15.0",
    appCode: name,
    metadata,
  };
  const appData = JSON.stringify(doc);
  const bytes = keccak_256(new TextEncoder().encode(appData));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return { appData, appDataHash: `0x${hex}`, partnerFeeBps };
}

/**
 * Volume bps declared by an appData document.
 *
 * buildOrder reads the bps back out of the doc the quote echoed rather than
 * re-reading env, so the amount we net off the signed limit is always the fee
 * the order itself declares. An unreadable or unrecognized `partnerFee` throws:
 * returning 0 would sign a limit as if no fee were charged, and the solver
 * would take the fee out of the user's proceeds anyway.
 */
export function cowPartnerFeeBpsFromAppData(appData: string): number {
  let doc: unknown;
  try {
    doc = JSON.parse(appData);
  } catch (err) {
    throw new Error(
      `cow: appData is not valid JSON, cannot determine the partner fee (${String(err)}) — ${appData}`,
    );
  }

  const partnerFee = (doc as { metadata?: { partnerFee?: unknown } } | null)
    ?.metadata?.partnerFee;
  if (partnerFee == null) return 0;

  // The schema allows an array of fees; mirror the SDK and take the first
  // volume-typed entry so a doc normalized into array form still nets.
  const entries: unknown[] = Array.isArray(partnerFee) ? partnerFee : [partnerFee];
  for (const entry of entries) {
    const bps = (entry as { volumeBps?: unknown } | null)?.volumeBps;
    if (typeof bps === "number" && Number.isInteger(bps) && bps >= 0) {
      if (bps > COW_PARTNER_FEE_BPS_MAX) {
        throw new Error(
          `cow: appData declares volumeBps=${bps}, above the ${COW_PARTNER_FEE_BPS_MAX} bps ceiling — refusing to net it off the signed limit`,
        );
      }
      return bps;
    }
  }

  throw new Error(
    `cow: unrecognized metadata.partnerFee in appData, refusing to sign an order whose fee cannot be netted — ${JSON.stringify(partnerFee)}`,
  );
}

function rejectIfNative(addr: string, role: "tokenIn" | "tokenOut"): void {
  if (addr.toLowerCase() === NATIVE_SENTINEL) {
    throw new Error(
      `cow does not support native ETH as ${role} — wrap to WETH (or the chain's wrapped native) and pass that address.`,
    );
  }
}

/**
 * Pure builder for POST /api/v1/quote body.
 * - sell → `kind: "sell"` + `sellAmountBeforeFee` (exact-in)
 * - buy  → `kind: "buy"`  + `buyAmountAfterFee`  (exact-out; never send sellAmountBeforeFee)
 */
export function buildCowQuoteRequestBody(opts: {
  sellToken: string;
  buyToken: string;
  from?: string;
  receiver?: string;
  side: CowSide;
  /** Fixed when side=sell */
  amountIn?: bigint;
  /** Fixed when side=buy */
  amountOut?: bigint;
  appData: string;
  appDataHash: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sellToken: opts.sellToken.toLowerCase(),
    buyToken: opts.buyToken.toLowerCase(),
    from: opts.from ?? COW_QUOTE_PLACEHOLDER,
    receiver: opts.receiver ?? COW_QUOTE_PLACEHOLDER,
    signingScheme: "eip712",
    appData: opts.appData,
    appDataHash: opts.appDataHash,
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
    onchainOrder: false,
  };

  if (opts.side === "buy") {
    if (opts.amountOut == null) {
      throw new Error("cow: side=buy requires amountOut (buyAmountAfterFee)");
    }
    return {
      ...base,
      kind: "buy",
      buyAmountAfterFee: opts.amountOut.toString(),
    };
  }

  if (opts.amountIn == null) {
    throw new Error("cow: side=sell requires amountIn (sellAmountBeforeFee)");
  }
  return {
    ...base,
    kind: "sell",
    sellAmountBeforeFee: opts.amountIn.toString(),
  };
}

// Fixed-point so tiny fees (CoW's can be sub-bp) survive the Number conversion.
function feeSharePct(fee: bigint, denom: bigint): number {
  return denom > 0n ? Number((fee * 100_000_000n) / denom) / 1_000_000 : 0;
}

/**
 * CIP-75 partner fee in the surplus token, in raw units.
 *
 * The orderbook does NOT net this out of the quote — the SDK's
 * `getQuoteAmountsAfterPartnerFee` does it client-side, and this mirrors it
 * with protocolFeeBps = 0. The base is the amount *before all fees*, so a sell
 * has to gross the network cost back up into buyAmount first.
 *
 * Clamped independently of user slippage: this is our own fee, not their
 * tolerance (same reasoning as ophis.ts).
 */
function cowPartnerFeeAmount(opts: {
  side: CowSide;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  partnerFeeBps: number;
}): bigint {
  const bps = Math.max(0, Math.min(10_000, Math.trunc(opts.partnerFeeBps)));
  if (bps <= 0) return 0n;

  const sell = BigInt(opts.sellAmount);
  if (opts.side === "buy") return (sell * BigInt(bps)) / 10_000n;

  const buy = BigInt(opts.buyAmount);
  const fee = BigInt(opts.feeAmount);
  const grossBuy = sell > 0n ? buy + (buy * fee) / sell : buy;
  return (grossBuy * BigInt(bps)) / 10_000n;
}

/**
 * Normalize quote envelope → display amounts.
 * Wallet outflow is always sellAmount + feeAmount (network cost leaves the
 * wallet too). For buy quotes the same sum is the estimated max pay; amountOut
 * is the fixed buy target from the envelope.
 *
 * The partner fee is netted here so ranking compares what the user actually
 * receives (sell) or pays (buy). On a sell the two fees sit in different
 * tokens and only one `protocolFee` slot exists, so the partner fee takes it.
 */
export function normalizeCowQuoteAmounts(q: {
  side: CowSide;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  partnerFeeBps: number;
}): {
  amountIn: string;
  amountOut: string;
  protocolFee: { raw: string; sharePct: number; side: "in" | "out" } | null;
} {
  const sell = BigInt(q.sellAmount);
  const fee = BigInt(q.feeAmount);
  const buy = BigInt(q.buyAmount);
  const partnerFee = cowPartnerFeeAmount(q);

  if (q.side === "buy") {
    const amountIn = sell + fee + partnerFee;
    const raw = fee + partnerFee;
    return {
      amountIn: amountIn.toString(),
      amountOut: buy.toString(),
      protocolFee:
        raw > 0n
          ? { raw: raw.toString(), sharePct: feeSharePct(raw, amountIn), side: "in" }
          : null,
    };
  }

  const totalIn = sell + fee;
  if (partnerFee > 0n) {
    return {
      amountIn: totalIn.toString(),
      amountOut: (buy - partnerFee).toString(),
      protocolFee: {
        raw: partnerFee.toString(),
        sharePct: feeSharePct(partnerFee, buy),
        side: "out",
      },
    };
  }

  return {
    amountIn: totalIn.toString(),
    amountOut: buy.toString(),
    protocolFee:
      fee > 0n
        ? { raw: q.feeAmount, sharePct: feeSharePct(fee, totalIn), side: "in" }
        : null,
  };
}

/**
 * Signed order amounts after NonZeroFee fold + slippage.
 *
 * CoW rejects feeAmount != 0 (HTTP 400 NonZeroFee). Always fold the quote fee
 * into sellAmount and sign feeAmount = "0".
 *
 * The partner fee lands where the SDK's `amountsToSign` puts it: off the
 * buy limit on a sell, onto the max spend on a buy. Signing the un-netted
 * amount would make the order unfillable once the solver takes the fee.
 *
 * - sell: sellAmount = sell+fee (exact pay); buyAmount = (buy - partner fee) shrunk by slippage (min out)
 * - buy:  buyAmount stays the exact target; sellAmount = (sell+fee+partner fee) * (1 + slip) (max in)
 *
 * @see https://docs.cow.fi — buy orders: sellAmount is max spend; buyAmount is exact receive
 */
export function cowSignedOrderAmounts(opts: {
  kind: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  partnerFeeBps: number;
  slippageBps: number;
}): {
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  kind: CowSide;
} {
  const totalSell = BigInt(opts.sellAmount) + BigInt(opts.feeAmount);
  const buy = BigInt(opts.buyAmount);
  const kind: CowSide = opts.kind === "buy" ? "buy" : "sell";
  const partnerFee = cowPartnerFeeAmount({
    side: kind,
    sellAmount: opts.sellAmount,
    buyAmount: opts.buyAmount,
    feeAmount: opts.feeAmount,
    partnerFeeBps: opts.partnerFeeBps,
  });

  if (kind === "buy") {
    return {
      sellAmount: maxAmountIn(totalSell + partnerFee, opts.slippageBps).toString(),
      buyAmount: buy.toString(),
      feeAmount: "0",
      kind: "buy",
    };
  }

  return {
    sellAmount: totalSell.toString(),
    buyAmount: minAmountOut(buy - partnerFee, opts.slippageBps).toString(),
    feeAmount: "0",
    kind: "sell",
  };
}

type CowQuoteEnvelope = {
  sellToken: string;
  buyToken: string;
  receiver: string;
  sellAmount: string;
  buyAmount: string;
  validTo: number;
  appData: string;
  appDataHash: string;
  feeAmount: string;
  kind: string;
  partiallyFillable: boolean;
  sellTokenBalance: string;
  buyTokenBalance: string;
  signingScheme: string;
};

type CowQuoteResponse = {
  quote?: CowQuoteEnvelope;
  from?: string;
  expiration?: string;
  id?: number;
  description?: string;
  errorType?: string;
};

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  /** Exact-in pay amount (side=sell, default). */
  amountIn?: bigint;
  /** Exact-out receive amount (side=buy). */
  amountOut?: bigint;
  /** Defaults to "sell" for back-compat with the amountIn-only pipeline. */
  side?: CowSide;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut } = params;
  const side: CowSide = params.side ?? "sell";

  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — CoW's settlement unwraps WETH → ETH
  // when buyToken == NATIVE_SENTINEL (0xeee…), and the API accepts
  // the sentinel directly. We pass it through unchanged.

  const network = networkFor(chain);

  // Same appData for the quote and the eventual order — the orderbook binds the
  // quote to this appDataHash, and the response echoes both back for buildOrder.
  const { appData, appDataHash, partnerFeeBps } = buildCowAppData();

  const body = buildCowQuoteRequestBody({
    sellToken: tokenIn,
    buyToken: tokenOut,
    side,
    amountIn: params.amountIn,
    amountOut: params.amountOut,
    appData,
    appDataHash,
  });

  const url = `https://api.cow.fi/${network}/api/v1/quote`;
  const res = await venueFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  const json = await parseJsonOrWarn<CowQuoteResponse>(res, "cow /quote");
  if (!res.ok || !json.quote) {
    const detail = json.description ?? json.errorType;
    throw new Error(
      `cow ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }

  const q = json.quote;

  // CoW does not expose hops in its quote — settlement is determined by the
  // solver auction. Renderer falls back to "(no route)".
  const hops: NormalizedHop[] = [];

  // Total outflow from the user's wallet = sellAmount (to counterparty) +
  // feeAmount (to protocol). For sell this equals sellAmountBeforeFee; for buy
  // it is the estimated pay (pre-slippage). Never display post-fee sell alone.
  const { amountIn, amountOut, protocolFee } = normalizeCowQuoteAmounts({
    side,
    sellAmount: q.sellAmount,
    buyAmount: q.buyAmount,
    feeAmount: q.feeAmount,
    partnerFeeBps,
  });

  return {
    venue: "cow",
    amountIn,
    amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null, // filler pays gas; not user-payable
    gasPriceWei: null,
    gasUsd: null,
    router: GPV2_SETTLEMENT,
    hops,
    tokenHints: new Map(),
    protocolFee,
    raw: json,
  };
}

export async function buildOrder(
  params: BuildTxParams,
): Promise<NormalizedOrder> {
  const { chain, tokenIn, sender, slippageBps, quote: q } = params;

  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — CoW's settlement unwraps WETH → ETH
  // when buyToken == NATIVE_SENTINEL (0xeee…), and the API accepts
  // the sentinel directly. We pass it through unchanged.

  // Reuse the same quote envelope the user saw on screen. Re-quoting would
  // race the price; the original validTo / amounts stay self-consistent.
  const raw = q.raw as CowQuoteResponse | undefined;
  if (!raw?.quote) {
    throw new Error(`cow buildOrder: missing quote envelope in NormalizedQuote.raw`);
  }
  const r = raw.quote;

  // Bind the netting to the fee the echoed document actually declares — this
  // is the doc that gets signed, so env drifting since the quote can't skew it.
  const partnerFeeBps = cowPartnerFeeBpsFromAppData(r.appData);

  // NonZeroFee fold + CIP-75 + side-aware slippage (see cowSignedOrderAmounts).
  const signed = cowSignedOrderAmounts({
    kind: r.kind,
    sellAmount: r.sellAmount,
    buyAmount: r.buyAmount,
    feeAmount: r.feeAmount,
    partnerFeeBps,
    slippageBps,
  });

  const sellToken = toChecksumAddress(r.sellToken);
  const buyToken = toChecksumAddress(r.buyToken);
  const receiver = toChecksumAddress(sender);

  // EIP-712 message — note appData here is the bytes32 hash, not the JSON
  // string. The hash is what gets hashed into the digest the user signs;
  // the string form goes into the order POST body so the orderbook can
  // surface it back.
  const message: Record<string, unknown> = {
    sellToken,
    buyToken,
    receiver,
    sellAmount: signed.sellAmount,
    buyAmount: signed.buyAmount,
    validTo: r.validTo,
    appData: r.appDataHash,
    feeAmount: signed.feeAmount,
    kind: signed.kind,
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };

  const typedData: Eip712TypedData = {
    domain: {
      name: "Gnosis Protocol",
      version: "v2",
      chainId: chain.chainId,
      verifyingContract: GPV2_SETTLEMENT,
    },
    types: {
      Order: [
        { name: "sellToken", type: "address" },
        { name: "buyToken", type: "address" },
        { name: "receiver", type: "address" },
        { name: "sellAmount", type: "uint256" },
        { name: "buyAmount", type: "uint256" },
        { name: "validTo", type: "uint32" },
        { name: "appData", type: "bytes32" },
        { name: "feeAmount", type: "uint256" },
        { name: "kind", type: "string" },
        { name: "partiallyFillable", type: "bool" },
        { name: "sellTokenBalance", type: "string" },
        { name: "buyTokenBalance", type: "string" },
      ],
    },
    primaryType: "Order",
    message,
  };

  // Body for POST /orders. Carries the original appData JSON string in
  // addition to the hash, plus signingScheme + a signature placeholder the
  // caller fills in after signing typedData.
  const submitBody: Record<string, unknown> = {
    ...message,
    appData: r.appData,
    appDataHash: r.appDataHash,
    signingScheme: "eip712",
    signature: null,
    from: receiver,
  };
  if (raw.id !== undefined) submitBody.quoteId = raw.id;

  const network = networkFor(chain);

  return {
    kind: "order",
    venue: "cow",
    spender: GPV2_VAULT_RELAYER,
    signer: receiver,
    typedData,
    submit: {
      url: `https://api.cow.fi/${network}/api/v1/orders`,
      method: "POST",
      bodyTemplate: submitBody,
    },
    validUntilSec: r.validTo,
    decayStartSec: null,
    chainId: chain.chainId,
  };
}

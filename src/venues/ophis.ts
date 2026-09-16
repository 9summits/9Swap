import type { ChainInfo } from "../chains.ts";
import type {
  BuildResult,
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
import {
  buildOphisAppDataPartnerFee,
  buildOphisOrderMetadata,
  ophisVolumeBpsForChainAndPair,
  buildOphisReferrerMetadata,
  getOphisOrderbookUrl,
  getOphisOrderDomain,
  getOphisSettlementAddress,
  getOphisVaultRelayer,
  isOphisStablePair,
  OPHIS_ORDERBOOK_URLS,
  OPHIS_PARTNER_FEE_RECIPIENT,
  OPHIS_VOLUME_FEE_BPS,
  OPHIS_PRICE_IMPROVEMENT_BPS,
  OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
  OPHIS_STABLE_PRICE_IMPROVEMENT_BPS,
  OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
  enrollOphisTrader,
  assertReceiverIsOwner,
  isOphisEthFlowChain,
  buildOphisEthFlowOrder,
  type EthFlowOrderTuple,
} from "@ophis/sdk";

// Ophis is a CoW Protocol fork. On CoW-hosted chains (eth/arb/base/bsc/avax
// here) it settles via CoW's canonical GPv2 contracts (api.cow.fi-hosted), so
// an ERC-20 sell is `cow` plus the appData tag (appCode "ophis" + CIP-75
// partner fee + our ophisReferrer code) and a one-time rebate-indexer
// enrollment. Ophis-OPERATED chains (Unichain 130 among ours) run Ophis's own
// settlement/relayer/eth-flow deployments + a self-hosted orderbook — the
// canonical CoW addresses are wrong there (signatures fail validation,
// approvals go to a relayer that never pulls). A NATIVE-ETH sell can't be an
// off-chain signed order (there's no token to pull), so it goes through the
// on-chain eth-flow `createOrder` tx instead (@ophis/sdk's buildOphisEthFlowOrder)
// — still gasless to settle, only the order placement is on-chain. The SDK owns
// every per-chain address (orderbook host, signing domain, vault relayer,
// eth-flow contract) and the silent-failure details; we never hardcode them.
//
// Fee policy (@ophis/sdk ≥0.4.2, all served chains): 1 bp base Volume fee, plus
// pair-aware PriceImprovement capture on CoW-hosted chains (volatile 80%/99 bp
// cap, stable 50%/20 bp cap). Ophis-operated backends apply improvement
// server-side, so appData carries only the 1 bp Volume entry there.

const QUOTE_PLACEHOLDER = "0x000000000000000000000000000000000000dEaD";

// Resolve + validate the chain: it must have a live Ophis orderbook. Returns
// the orderbook base URL.
function orderbookFor(chain: ChainInfo): string {
  if (!(chain.chainId in OPHIS_ORDERBOOK_URLS)) {
    throw new UnsupportedChainError("ophis", chain.displayName);
  }
  return getOphisOrderbookUrl(chain.chainId);
}

// buyToken must be a real ERC-20 — eth-flow and the orderbook both reject the
// native sentinel as the bought token.
function hashHex(s: string): `0x${string}` {
  const bytes = keccak_256(new TextEncoder().encode(s));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

// Build the order's appData document, byte-identical to @ophis/sdk's
// buildOphisOrderMetadata + cow-sdk generateAppDataDoc/stringifyDeterministic
// (sorted keys, no `signer` for EOA/eth-flow). Carries appCode "ophis", the
// CIP-75 partner fee (base Volume + pair-aware PriceImprovement on hosted
// chains), and our ophisReferrer code — the rebate money path.
// ponytail: version pinned to "1.15.0" (what cow-sdk@9 emits); re-pin if the
// canonical generator's output ever diverges (self-check guards it).
// volumeBps is the flat Volume component only (always 1 bp) — used to net
// display / signed amounts. PriceImprovement is surplus-sourced at settlement
// and must not be folded into the limit as a fixed bps.
function buildOphisAppData(
  chainId: number,
  stable: boolean,
): { appData: string; appDataHash: `0x${string}`; volumeBps: number } {
  const partnerFee = buildOphisAppDataPartnerFee(chainId, stable);
  if (!partnerFee) throw new UnsupportedChainError("ophis", String(chainId));
  const volumeBps = ophisVolumeBpsForChainAndPair(chainId, stable);
  const code = getReferralConfig().ophisReferralCode;

  const doc: Record<string, unknown> = {
    appCode: "ophis",
    metadata: {
      hooks: {},
      ...(code ? buildOphisReferrerMetadata(code) : {}),
      // Pass the SDK config verbatim (object on sovereign chains, array of
      // Volume + PriceImprovement on CoW-hosted chains). Do not flatten.
      partnerFee,
    },
    version: "1.15.0",
  };
  const appData = JSON.stringify(doc);
  return { appData, appDataHash: hashHex(appData), volumeBps };
}

// ---- eth-flow createOrder calldata --------------------------------------
// The createOrder tuple is all-static (address/uint/bytes32/bool), so the
// struct encodes inline as nine 32-byte words after the selector — no dynamic
// offsets. Hand-encoded to avoid pulling ethers/viem into the CLI.
const CREATE_ORDER_SELECTOR = (() => {
  const sig =
    "createOrder((address,address,uint256,uint256,bytes32,uint256,uint32,bool,int64))";
  const b = keccak_256(new TextEncoder().encode(sig)).slice(0, 4);
  let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return `0x${h}`;
})();

function encodeCreateOrder(t: EthFlowOrderTuple): string {
  const w = (hex: string) => hex.padStart(64, "0");
  const addr = (a: string) => w(a.toLowerCase().replace(/^0x/, ""));
  const uint = (n: bigint | number) => w(BigInt(n).toString(16));
  const b32 = (h: string) => w(h.replace(/^0x/, ""));
  const bool = (v: boolean) => w(v ? "1" : "0");
  const words = [
    addr(t[0]), // buyToken
    addr(t[1]), // receiver
    uint(t[2]), // sellAmount
    uint(t[3]), // buyAmount
    b32(t[4]), // appData (bytes32)
    uint(t[5]), // feeAmount (0)
    uint(t[6]), // validTo
    bool(t[7]), // partiallyFillable
    uint(t[8]), // quoteId (int64, validated non-negative)
  ];
  return CREATE_ORDER_SELECTOR + words.join("");
}

// PUT the full appData JSON to the orderbook so solvers honor the partner fee.
// Required for eth-flow (the on-chain order only commits the hash); without it
// the fee — and the rebate — silently drop.
async function uploadAppData(
  baseUrl: string,
  appDataHash: string,
  fullAppData: string,
): Promise<void> {
  const res = await venueFetch(`${baseUrl}/api/v1/app_data/${appDataHash}`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ fullAppData }),
  });
  // The orderbook returns 200/201 on success and 200 if it already has the doc.
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `ophis: appData upload failed (${res.status} ${res.statusText})${body ? ` — ${body.slice(0, 200)}` : ""} — the partner fee would be dropped.`,
    );
  }
}

type OphisQuoteEnvelope = {
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

type OphisQuoteResponse = {
  quote?: OphisQuoteEnvelope;
  from?: string;
  expiration?: string;
  id?: number;
  description?: string;
  errorType?: string;
};

async function postQuote(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<OphisQuoteResponse> {
  const res = await venueFetch(`${baseUrl}/api/v1/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJsonOrWarn<OphisQuoteResponse>(res, "ophis /quote");
  if (!res.ok || !json.quote) {
    const detail = json.description ?? json.errorType;
    throw new Error(
      `ophis ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return json;
}

// The on-chain sell token for the orderbook quote: native ETH sells as WETH
// (eth-flow wraps it), everything else sells as itself.
function quoteSellToken(chain: ChainInfo, tokenIn: string): string {
  if (tokenIn.toLowerCase() !== NATIVE_SENTINEL) return tokenIn.toLowerCase();
  // eth-flow needs a wrapper to sell native through. Chains without one (Arc,
  // where the gas token is itself an ERC20) never reach here — ophis doesn't
  // serve them — but fail loud rather than deref a null.
  if (chain.wrappedNative === null) {
    throw new Error(
      `ophis cannot sell native ${chain.nativeSymbol} on ${chain.displayName}: ` +
        `the chain has no wrapped-native token`,
    );
  }
  return chain.wrappedNative.toLowerCase();
}

/** Exact-in (sell) vs exact-out (buy). Matches orderbook `kind`. */
export type OphisSide = "sell" | "buy";

/**
 * Pure builder for POST /api/v1/quote body (CoW-compatible orderbook).
 * - sell → `kind: "sell"` + `sellAmountBeforeFee`
 * - buy  → `kind: "buy"`  + `buyAmountAfterFee` (never sellAmountBeforeFee)
 */
export function buildOphisQuoteRequestBody(opts: {
  sellToken: string;
  buyToken: string;
  from: string;
  receiver: string;
  side: OphisSide;
  amountIn?: bigint;
  amountOut?: bigint;
  appData: string;
  appDataHash: string;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sellToken: opts.sellToken.toLowerCase(),
    buyToken: opts.buyToken.toLowerCase(),
    from: opts.from,
    receiver: opts.receiver,
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
      throw new Error("ophis: side=buy requires amountOut (buyAmountAfterFee)");
    }
    return {
      ...base,
      kind: "buy",
      buyAmountAfterFee: opts.amountOut.toString(),
    };
  }

  if (opts.amountIn == null) {
    throw new Error("ophis: side=sell requires amountIn (sellAmountBeforeFee)");
  }
  return {
    ...base,
    kind: "sell",
    sellAmountBeforeFee: opts.amountIn.toString(),
  };
}

/**
 * Display amounts after CIP-75 volume fee netting.
 *
 * - sell: fee is charged in the buy (surplus) token → shrink amountOut
 * - buy:  fee is charged in the sell (surplus) token → grow amountIn
 *   so ranking / approve path use the full wallet outflow.
 */
export function normalizeOphisQuoteAmounts(opts: {
  side: OphisSide;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  volumeBps: number;
}): {
  amountIn: string;
  amountOut: string;
  protocolFee: { raw: string; sharePct: number; side: "in" | "out" } | null;
} {
  const volumeBps = Math.max(0, Math.min(10_000, Math.trunc(opts.volumeBps)));
  const baseIn = BigInt(opts.sellAmount) + BigInt(opts.feeAmount);
  const grossOut = BigInt(opts.buyAmount);

  if (opts.side === "buy") {
    // Partner volume fee on sell token for buy orders.
    const totalIn = (baseIn * BigInt(10_000 + volumeBps)) / 10_000n;
    const feeRaw = totalIn - baseIn;
    return {
      amountIn: totalIn.toString(),
      amountOut: grossOut.toString(), // fixed receive (buyAmountAfterFee)
      protocolFee:
        feeRaw > 0n || BigInt(opts.feeAmount) > 0n
          ? {
              raw: (feeRaw + BigInt(opts.feeAmount)).toString(),
              sharePct: volumeBps / 100,
              side: "in",
            }
          : null,
    };
  }

  // sell: net buyAmount so ranking uses what the user actually receives
  const netOut = (grossOut * BigInt(10_000 - volumeBps)) / 10_000n;
  return {
    amountIn: baseIn.toString(),
    amountOut: netOut.toString(),
    protocolFee: {
      raw: (grossOut - netOut).toString(),
      sharePct: volumeBps / 100,
      side: "out",
    },
  };
}

/**
 * Signed / eth-flow committed amounts after NonZeroFee fold + CIP-75 + slippage.
 *
 * - Always sign feeAmount = "0" (orderbook NonZeroFee).
 * - sell: fold network fee into sell; net CIP-75 off buy; shrink buy by slip
 * - buy:  fold network fee + CIP-75 into max sell; expand sell by slip; buy exact
 */
export function ophisSignedOrderAmounts(opts: {
  kind: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  volumeBps: number;
  slippageBps: number;
}): {
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  kind: OphisSide;
} {
  // volumeBps is CIP-75 partner fee, not user slippage — clamp independently.
  const volumeBps = Math.max(0, Math.min(10_000, Math.trunc(opts.volumeBps)));
  const kind: OphisSide = opts.kind === "buy" ? "buy" : "sell";
  const totalSell = BigInt(opts.sellAmount) + BigInt(opts.feeAmount);
  const grossBuy = BigInt(opts.buyAmount);

  if (kind === "buy") {
    // CIP-75 volume fee on sell token + user slippage on max pay.
    const sellWithPartner = (totalSell * BigInt(10_000 + volumeBps)) / 10_000n;
    return {
      sellAmount: maxAmountIn(sellWithPartner, opts.slippageBps).toString(),
      buyAmount: grossBuy.toString(),
      feeAmount: "0",
      kind: "buy",
    };
  }

  const netBuy = (grossBuy * BigInt(10_000 - volumeBps)) / 10_000n;
  return {
    sellAmount: totalSell.toString(),
    buyAmount: minAmountOut(netBuy, opts.slippageBps).toString(),
    feeAmount: "0",
    kind: "sell",
  };
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  /** Exact-in pay amount (side=sell, default). */
  amountIn?: bigint;
  /** Exact-out receive amount (side=buy). */
  amountOut?: bigint;
  /** Defaults to "sell" for back-compat with the amountIn-only pipeline. */
  side?: OphisSide;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut } = params;
  const side: OphisSide = params.side ?? "sell";

  // tokenOut native is fine — like CoW, settlement unwraps WETH → ETH when
  // buyToken == NATIVE_SENTINEL (0xeee…); the orderbook accepts the sentinel.
  const baseUrl = orderbookFor(chain);
  const nativeIn = tokenIn.toLowerCase() === NATIVE_SENTINEL;
  if (nativeIn && !isOphisEthFlowChain(chain.chainId)) {
    throw new Error(
      `ophis: native ETH input isn't supported on ${chain.displayName} via eth-flow — wrap to WETH.`,
    );
  }
  // eth-flow createOrder has no `kind` field — only exact-in ETH sells.
  if (nativeIn && side === "buy") {
    throw new Error(
      "ophis: exact-out (buy) with native ETH input is not supported via eth-flow — wrap to WETH and use an ERC-20 buy order.",
    );
  }

  const sellToken = quoteSellToken(chain, tokenIn);
  const stable = isOphisStablePair(chain.chainId, sellToken, tokenOut);
  const { appData, appDataHash, volumeBps } = buildOphisAppData(chain.chainId, stable);

  const json = await postQuote(
    baseUrl,
    buildOphisQuoteRequestBody({
      sellToken,
      buyToken: tokenOut,
      from: QUOTE_PLACEHOLDER,
      receiver: QUOTE_PLACEHOLDER,
      side,
      amountIn: params.amountIn,
      amountOut: params.amountOut,
      appData,
      appDataHash,
    }),
  );
  const q = json.quote!;

  // CoW/Ophis doesn't expose hops — the solver auction picks settlement.
  const hops: NormalizedHop[] = [];

  const norm = normalizeOphisQuoteAmounts({
    side,
    sellAmount: q.sellAmount,
    buyAmount: q.buyAmount,
    feeAmount: q.feeAmount,
    volumeBps,
  });

  return {
    venue: "ophis",
    amountIn: norm.amountIn,
    amountOut: norm.amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null, // filler pays gas (eth-flow: + the one-time createOrder tx)
    gasPriceWei: null,
    gasUsd: null,
    router: getOphisSettlementAddress(chain.chainId),
    hops,
    tokenHints: new Map(),
    // Ophis CIP-75 base Volume fee (1 bp, from SDK). PriceImprovement is
    // surplus-sourced at settlement and not folded into this display net.
    // Side depends on order kind (out for sell, in for buy).
    protocolFee: norm.protocolFee,
    raw: json,
  };
}

export async function buildOrder(params: BuildTxParams): Promise<BuildResult> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps, quote: priorQuote } =
    params;

  // tokenOut native is fine — settlement unwraps WETH → ETH (see quote()).
  const baseUrl = orderbookFor(chain);
  const senderCs = toChecksumAddress(sender);
  const nativeIn = tokenIn.toLowerCase() === NATIVE_SENTINEL;
  if (nativeIn && !isOphisEthFlowChain(chain.chainId)) {
    throw new Error(
      `ophis: native ETH input isn't supported on ${chain.displayName} via eth-flow — wrap to WETH.`,
    );
  }

  // Infer side from the quote the user saw (envelope kind) so buy orders
  // re-quote with buyAmountAfterFee. Default sell if raw is missing/legacy.
  const priorRaw = priorQuote?.raw as OphisQuoteResponse | undefined;
  const orderSide: OphisSide =
    priorRaw?.quote?.kind === "buy" ? "buy" : "sell";

  if (nativeIn && orderSide === "buy") {
    throw new Error(
      "ophis: exact-out (buy) with native ETH input is not supported via eth-flow — wrap to WETH and use an ERC-20 buy order.",
    );
  }

  // Enroll the wallet with the rebate indexer before placing the order — block
  // on failure, else the rebate silently never accrues. Idempotent.
  // sdk ≥0.3 defaults to best-effort; restore the fail-closed gate.
  await enrollOphisTrader(senderCs, { blocking: true });

  const sellToken = quoteSellToken(chain, tokenIn);
  const stable = isOphisStablePair(chain.chainId, sellToken, tokenOut);
  const { appData, appDataHash, volumeBps } = buildOphisAppData(chain.chainId, stable);

  // Fixed legs for re-quote: sell uses caller amountIn; buy reuses the exact
  // buyAmount from the prior envelope (or displayed amountOut as fallback).
  const buyFixed =
    orderSide === "buy"
      ? BigInt(priorRaw?.quote?.buyAmount ?? priorQuote.amountOut)
      : undefined;

  // Re-quote with the real sender + the binding appData (the indicative quote
  // used a placeholder). Mirrors delta/uniswapx/fusion.
  const json = await postQuote(
    baseUrl,
    buildOphisQuoteRequestBody({
      sellToken,
      buyToken: tokenOut,
      from: senderCs,
      receiver: senderCs,
      side: orderSide,
      amountIn: orderSide === "sell" ? amountIn : undefined,
      amountOut: buyFixed,
      appData,
      appDataHash,
    }),
  );
  const r = json.quote!;

  const signed = ophisSignedOrderAmounts({
    kind: r.kind,
    sellAmount: r.sellAmount,
    buyAmount: r.buyAmount,
    feeAmount: r.feeAmount,
    volumeBps,
    slippageBps,
  });

  // ---- native ETH → on-chain eth-flow createOrder tx ----------------------
  // eth-flow is sell-only (no kind field). orderSide=buy already rejected above.
  if (nativeIn) {
    if (json.id === undefined) {
      throw new Error("ophis eth-flow: quote response missing id (quoteId) — cannot bind the order.");
    }
    const built = buildOphisEthFlowOrder({
      chainId: chain.chainId,
      buyToken: toChecksumAddress(tokenOut) as `0x${string}`,
      owner: senderCs as `0x${string}`,
      sellAmount: BigInt(signed.sellAmount),
      buyAmount: BigInt(signed.buyAmount),
      fullAppData: appData,
      appDataHash,
      validTo: r.validTo,
      quoteId: json.id,
      hashAppData: hashHex, // verify the hash binds (fail-closed)
    });
    // Upload the full appData BEFORE the user sends createOrder, or the fee drops.
    await uploadAppData(baseUrl, appDataHash, built.appDataToUpload);
    return {
      kind: "tx",
      to: built.ethFlowContract,
      from: senderCs,
      data: encodeCreateOrder(built.orderTuple),
      value: built.value.toString(),
      gas: null,
      gasPrice: null,
      maxPriorityFeePerGas: null,
      spender: built.ethFlowContract, // native input — no ERC20 approval fires
      chainId: chain.chainId,
    };
  }

  // ---- ERC-20 → off-chain signed GPv2 order -------------------------------
  const sellTokenCs = toChecksumAddress(r.sellToken);
  const buyTokenCs = toChecksumAddress(r.buyToken);
  const receiver = senderCs;
  assertReceiverIsOwner(senderCs as `0x${string}`, receiver as `0x${string}`);

  // EIP-712 message — appData here is the bytes32 hash (the string form goes in
  // the POST body). Domain from the SDK (correct verifying contract per chain).
  const message: Record<string, unknown> = {
    sellToken: sellTokenCs,
    buyToken: buyTokenCs,
    receiver,
    sellAmount: signed.sellAmount,
    buyAmount: signed.buyAmount,
    validTo: r.validTo,
    appData: appDataHash,
    feeAmount: signed.feeAmount,
    kind: signed.kind,
    partiallyFillable: false,
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };

  const typedData: Eip712TypedData = {
    domain: getOphisOrderDomain(chain.chainId) as unknown as Record<
      string,
      string | number
    >,
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

  // POST /orders body — appData JSON STRING + its hash, EOA scheme, signature
  // placeholder the caller fills after signing.
  const submitBody: Record<string, unknown> = {
    ...message,
    appData,
    appDataHash,
    signingScheme: "eip712",
    signature: null,
    from: receiver,
  };
  if (json.id !== undefined) submitBody.quoteId = json.id;

  return {
    kind: "order",
    venue: "ophis",
    spender: getOphisVaultRelayer(chain.chainId),
    signer: receiver,
    typedData,
    submit: {
      url: `${baseUrl}/api/v1/orders`,
      method: "POST",
      bodyTemplate: submitBody,
    },
    validUntilSec: r.validTo,
    decayStartSec: null,
    chainId: chain.chainId,
  };
}

// Money-path self-check: appData must be byte-identical to the @ophis/sdk +
// cow-sdk canonical doc (carries ophisReferrer + the right CIP-75 fee), and the
// eth-flow calldata must be selector + 9 words. Run: `bun run src/venues/ophis.ts`.
//
// SELF_CHECK_REF_CODE is a dummy referral string used only as a fixture so the
// golden appData / hashes stay deterministic. Runtime still reads
// OPHIS_REFERRAL_CODE from the env (no default).
if (import.meta.main) {
  const SELF_CHECK_REF_CODE = "fixture";
  process.env.OPHIS_REFERRAL_CODE = SELF_CHECK_REF_CODE;
  const { resetReferralConfigCache } = await import("../referral.ts");
  resetReferralConfigCache();

  // Canonical strings + hashes for @ophis/sdk 0.4.2 fee policy (1 bp base +
  // pair-aware PriceImprovement on hosted chains). Frozen on purpose: an SDK
  // bump that moves the canonical output must fail here and force a conscious
  // re-verification of the money path.
  const expect = {
    1: {
      stable:
        `{"appCode":"ophis","metadata":{"hooks":{},"ophisReferrer":{"code":"${SELF_CHECK_REF_CODE}"},"partnerFee":[{"volumeBps":1,"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8"},{"priceImprovementBps":${OPHIS_STABLE_PRICE_IMPROVEMENT_BPS},"maxVolumeBps":${OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS},"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8"}]},"version":"1.15.0"}`,
      volatile:
        `{"appCode":"ophis","metadata":{"hooks":{},"ophisReferrer":{"code":"${SELF_CHECK_REF_CODE}"},"partnerFee":[{"volumeBps":1,"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8"},{"priceImprovementBps":${OPHIS_PRICE_IMPROVEMENT_BPS},"maxVolumeBps":${OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS},"recipient":"0x858f0F5eE954846D47155F5203c04aF1819eCeF8"}]},"version":"1.15.0"}`,
    },
  } as const;
  const s = buildOphisAppData(1, true);
  if (s.appData !== expect[1].stable) throw new Error(`stable appData not canonical:\n${s.appData}`);
  if (s.volumeBps !== OPHIS_VOLUME_FEE_BPS) throw new Error(`stable volumeBps must be ${OPHIS_VOLUME_FEE_BPS}`);
  const v = buildOphisAppData(1, false);
  if (v.appData !== expect[1].volatile) throw new Error(`volatile appData not canonical:\n${v.appData}`);
  if (v.volumeBps !== OPHIS_VOLUME_FEE_BPS) throw new Error(`volatile volumeBps must be ${OPHIS_VOLUME_FEE_BPS}`);
  // Hosted-chain partnerFee is an array; recipient on every entry must be Ophis.
  for (const entry of JSON.parse(s.appData).metadata.partnerFee as Array<{ recipient: string }>) {
    if (entry.recipient.toLowerCase() !== OPHIS_PARTNER_FEE_RECIPIENT.toLowerCase()) {
      throw new Error("partnerFee.recipient != OPHIS_PARTNER_FEE_RECIPIENT");
    }
  }
  // Re-hash fixture strings so a silent edit of the golden literal fails closed.
  if (s.appDataHash !== hashHex(expect[1].stable)) throw new Error("stable appDataHash mismatch");
  if (v.appDataHash !== hashHex(expect[1].volatile)) throw new Error("volatile appDataHash mismatch");

  // Live cross-check against the SDK's own canonical builder: our hand-rolled
  // doc must equal buildOphisOrderMetadata's output with sorted keys + the
  // pinned version. Chain 130 (Unichain) included: sovereign chains emit a
  // single Volume object (backend supplies improvement); hosted emit the array.
  const sortDeep = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sortDeep);
    if (x !== null && typeof x === "object") {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, sortDeep(val)]),
      );
    }
    return x;
  };
  for (const chainId of [1, 130]) {
    for (const stablePair of [true, false]) {
      // Compare after deep key-sort: partnerFee Volume entries emit
      // volumeBps-before-recipient (SDK insertion order), which is not
      // alphabetical; content must still match buildOphisOrderMetadata.
      const ours = JSON.stringify(sortDeep(JSON.parse(buildOphisAppData(chainId, stablePair).appData)));
      const sdkDoc = buildOphisOrderMetadata({
        chainId,
        referralCode: SELF_CHECK_REF_CODE,
        isStablePair: stablePair,
      });
      const canonical = JSON.stringify(sortDeep({ ...sdkDoc, version: "1.15.0" }));
      if (ours !== canonical)
        throw new Error(
          `appData drifted from buildOphisOrderMetadata (chain ${chainId}, stable=${stablePair}):\nours: ${ours}\nsdk:  ${canonical}`,
        );
    }
  }

  // eth-flow calldata shape: selector (4 bytes) + 9 × 32-byte words.
  // Use volatile appData (native ETH sells are never stable↔stable).
  const tuple: EthFlowOrderTuple = [
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // buyToken
    "0x1111111111111111111111111111111111111111", // receiver
    1000000000000000000n, // sellAmount (1 ETH)
    2500000000n, // buyAmount
    v.appDataHash, // appData
    0n, // feeAmount
    1900000000, // validTo
    false, // partiallyFillable
    42, // quoteId
  ];
  const data = encodeCreateOrder(tuple);
  if (data.length !== 2 + 8 + 9 * 64) throw new Error(`calldata length ${data.length}, expected ${2 + 8 + 9 * 64}`);
  if (!data.startsWith(CREATE_ORDER_SELECTOR)) throw new Error("missing createOrder selector");
  // appData hash must appear verbatim as the 5th word.
  if (!data.includes(v.appDataHash.slice(2))) throw new Error("appData hash not encoded");
  console.log("ophis self-check: OK (appData canonical + SDK-builder cross-check + eth-flow calldata)");
}

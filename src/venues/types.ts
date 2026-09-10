import { BUY_CAPABLE_VENUES } from "../trade_side.ts";

export type SyncVenue = "kyber" | "odos" | "odosv2" | "velora" | "matcha" | "1inch" | "curve" | "uniswap" | "openocean";
export type AsyncVenue = "cow" | "delta" | "uniswapx" | "fusion" | "ophis";
export type Venue = SyncVenue | AsyncVenue;
export type VenueOption = Venue | "all";

export const SYNC_VENUES: SyncVenue[] = ["kyber", "odos", "odosv2", "velora", "matcha", "1inch", "curve", "uniswap", "openocean"];
export const ASYNC_VENUES: AsyncVenue[] = ["cow", "delta", "uniswapx", "fusion", "ophis"];
export const VENUES: Venue[] = [...SYNC_VENUES, ...ASYNC_VENUES];
export const VENUE_OPTIONS: VenueOption[] = [...VENUES, "all"];

export function isAsyncVenue(v: Venue): v is AsyncVenue {
  return (ASYNC_VENUES as readonly string[]).includes(v);
}

export class MissingApiKeyError extends Error {
  constructor(venue: Venue, envVar: string) {
    super(
      `${venue} requires an API key — set ${envVar} (free at ${apiKeyUrl(venue)})`,
    );
    this.name = "MissingApiKeyError";
  }
}

// Async venues return an EIP-712 order to sign (not a callable tx). The
// output semantics differ enough that opt-in must be explicit, otherwise
// scripts piping `--json` for `tx.data` would silently get a different
// shape and produce broken txs.
export class AsyncOptInRequiredError extends Error {
  constructor(venue: AsyncVenue) {
    super(
      `-v ${venue} returns an EIP-712 order (sign + POST), not a callable tx. ` +
        `Pass --allow-async to opt in.`,
    );
    this.name = "AsyncOptInRequiredError";
  }
}

// Exact-out (side="buy") is only supported by venues with a native buy /
// EXACT_OUTPUT path (BUY_CAPABLE_VENUES). Selecting a sell-only venue with
// --exact-out throws this — never silently fall back to an inverted exact-in
// quote (that would let the user pay an unbounded amountIn). Mirrors the
// explicit MissingApiKeyError / AsyncOptInRequiredError treatment.
export class UnsupportedSideError extends Error {
  constructor(venue: Venue) {
    super(
      `${venue} does not support exact-out (sell-only); ` +
        `buy-capable venues: ${BUY_CAPABLE_VENUES.join(", ")}`,
    );
    this.name = "UnsupportedSideError";
  }
}

function apiKeyUrl(venue: Venue): string {
  switch (venue) {
    case "matcha":
      return "https://dashboard.0x.org";
    case "1inch":
    case "fusion":
      return "https://portal.1inch.dev";
    case "uniswapx":
    case "uniswap":
      return "https://hub.uniswap.org";
    case "openocean":
      return "https://docs.openocean.finance/docs/swap-api/enterprise";
    default:
      return "";
  }
}

export type NormalizedHop = {
  tokenIn: string;
  tokenOut: string;
  exchange: string;
  swapAmount: string;
  /**
   * True when swapAmount is only a relative split weight denominated in the
   * ROUTE input token, not a real amount in this hop's tokenIn. Venues that
   * expose split ratios but no intermediate amounts (openocean, 1inch) set it
   * on downstream hops. Ratio math (format.ts grouping, ribbon widths) stays
   * valid; renderers must NOT display the value as an absolute amount.
   */
  approxAmount?: boolean;
  /** Hop output in tokenOut base units — only when the venue reports it. */
  amountOut?: string;
  pool?: string;
  /** Fee in hundredths of a bp (100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%). */
  fee?: number;
};

export type TokenHint = {
  symbol: string;
  name: string;
  decimals: number;
};

export type NormalizedQuote = {
  venue: Venue;
  amountIn: string;
  amountOut: string;
  /**
   * Guaranteed sell-side floor when `amountOut` is an optimistic cote (Fusion
   * Dutch-auction `auctionEndAmount`). Ranking, exact-out refine, and the
   * "min receive" UI use this when present; omitted when it equals amountOut.
   */
  minAmountOut?: string;
  amountInUsd: number | null;
  amountOutUsd: number | null;
  gasUnits: number | null;
  gasPriceWei: string | null;
  gasUsd: number | null;
  router: string | null;
  hops: NormalizedHop[];
  tokenHints: Map<string, TokenHint>;
  // Explicit fee surfaced by the venue's API. Distinct from the implicit
  // spread that aggregators bake into the price. CoW always returns one;
  // sync aggregators (kyber/odos/velora) only when an integrator/partner
  // is configured (we never set partner credentials, so it's typically
  // null). `side` records which token the fee is denominated in: "in"
  // means it's deducted from tokenIn (CoW), "out" means from tokenOut
  // (kyber/odos/velora). `sharePct` is fee / corresponding-amount × 100.
  protocolFee?: {
    raw: string;
    sharePct: number;
    side: "in" | "out";
  } | null;
  /**
   * Present when this quote was produced by the exact-out **sell refine** pass:
   * a sell-only venue was quoted as exact-in at the best native-buy `amountIn`
   * seed, and its `amountOut` met the user's receive target.
   *
   * Build must execute as exact-in (`side=sell`) with a min-out floor at
   * `targetAmountOut` (see `sellSlippageBpsForMinOutFloor`) — never as a
   * native buy (the venue has none) and never without receive protection.
   */
  buyRefine?: {
    /** Original exact-out receive target (tokenOut base units). */
    targetAmountOut: string;
    /** Seed pay amount used for the sell quote (tokenIn base units). */
    seedAmountIn: string;
  };
  raw: unknown;
};

export type NormalizedTx = {
  to: string;
  from: string | null;
  data: string;
  value: string;
  gas: string | null;
  gasPrice: string | null;
  maxPriorityFeePerGas: string | null;
  spender: string;
  chainId: number;
};

export type Eip712TypedData = {
  domain: Record<string, string | number>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Sync venue that requires the user to sign an EIP-712 permit BEFORE the
// executable tx can be assembled — currently only Uniswap's complex
// (V4 / split / mixed) routes via the Trading API's /v1/swap endpoint.
// The page signs typedData, POSTs the signature to the local server's
// /assemble endpoint, the server calls the venue API to get back the
// real broadcastable tx, and the page sends it. Two on-chain steps total
// (optional ERC20 approve to Permit2 + the swap), plus one off-chain
// signature.
export type NormalizedPermitTx = {
  kind: "permit-tx";
  venue: SyncVenue;
  // Approval target — Permit2. The ERC20 must be approved here once
  // (typically infinite); subsequent swaps just sign a fresh permit.
  spender: string;
  signer: string;
  typedData: Eip712TypedData;
  chainId: number;
};

export type NormalizedOrder = {
  kind: "order";
  venue: AsyncVenue;
  // Approval target — for orders this is the off-chain protocol's pull-payment
  // contract (e.g. GPv2VaultRelayer for CoW). Same field as NormalizedTx.spender
  // so the existing allowance check works without branching.
  spender: string;
  // Address that must sign the typed data — equals message.{from,owner,swapper,receiver}
  // depending on the venue.
  signer: string;
  typedData: Eip712TypedData;
  // After signing, POST this body (with the signature spliced in) to `url`.
  // bodyTemplate carries every field except the signature; callers attach it
  // before submitting.
  // `auth` describes a required auth header. The secret itself is never
  // embedded — consumers resolve `envVar` from the environment at submit
  // time. The --browser / interactive-dApp flows proxy authed submissions
  // through the local server so the key never reaches the page (and CORS
  // never fires).
  //   - bearer  → Authorization: Bearer <key>  (1inch Fusion relayer)
  //   - api-key → x-api-key: <key>              (Uniswap Trading API)
  submit: {
    url: string;
    method: "POST";
    bodyTemplate: Record<string, unknown>;
    auth?: { kind: "bearer" | "api-key"; envVar: string };
  };
  // EIP-712 order hash when the venue computes it client-side (fusion).
  // Used as the orderId fallback for relayers that return an empty body.
  orderHash?: string;
  validUntilSec: number;
  // Auction decay start (Dutch-style venues). Null for batch venues like CoW.
  decayStartSec: number | null;
  chainId: number;
};

// build() returns one of these — sync venues wrap NormalizedTx with a
// kind: "tx" discriminator so callers narrow once and read either tx.data
// (broadcast) or order.typedData (sign + POST). Async output never claims
// to be a tx; sync output never claims to be an order.
export type BuildResult =
  | ({ kind: "tx" } & NormalizedTx)
  | NormalizedOrder
  | NormalizedPermitTx;

export type BuildTxParams = {
  chain: import("../chains.ts").ChainInfo;
  tokenIn: string;
  tokenOut: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountIn: bigint;
  /** Fixed receive amount for exact-out (`side: "buy"`). */
  amountOut?: bigint;
  sender: string;
  slippageBps: number;
  quote: NormalizedQuote;
  /**
   * Exact-in (`sell`, default) vs exact-out (`buy`). Adapters that support
   * buy must honour this on quote *and* build — never reuse exact-in calldata
   * for a buy (e.g. Uniswap SwapRouter02 exactInput* for EXACT_OUTPUT).
   */
  side?: "sell" | "buy";
  /**
   * Odos V2 only (`--odosnotcompact` / dApp Advanced toggle). When true, the
   * build-side re-quote sends `compact: false` (default is `compact: true`).
   * Per-request so concurrent serverless builds cannot race a module flag.
   */
  odosNotCompact?: boolean;
  /**
   * Odos V2/V3 (`--disableodosrfq` / dApp Advanced toggle). When true, quote
   * and build send `disableRFQs: true` — workaround for tokens (e.g. FXN)
   * whose RFQ leg trips Odos errorCode 2999. Per-request so concurrent
   * serverless handlers cannot race the CLI module flag.
   */
  disableOdosRfq?: boolean;
};

export class UnsupportedChainError extends Error {
  constructor(venue: Venue, chainName: string) {
    super(`${venue} does not support ${chainName}`);
    this.name = "UnsupportedChainError";
  }
}

export function toNumOrNull(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const n = typeof s === "number" ? s : Number(s);
  return Number.isFinite(n) ? n : null;
}

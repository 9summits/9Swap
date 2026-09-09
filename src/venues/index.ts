import type { ChainInfo } from "../chains.ts";
import { sellSlippageBpsForMinOutFloor } from "../slippage.ts";
import { assertQuoteAmount, isBuyCapable, type TradeSide } from "../trade_side.ts";
import {
  compareBySide,
  effectiveRank,
  positiveAmount,
  rankAmount,
  toRankQuote,
  type RankMode,
  type RankQuote,
} from "../../shared/rank.ts";
import type {
  BuildResult,
  BuildTxParams,
  NormalizedPermitTx,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./types.ts";
import { ASYNC_VENUES, VENUES, UnsupportedSideError, isAsyncVenue } from "./types.ts";
import { withVenueTimeout } from "./http.ts";
import * as kyber from "./kyber.ts";
import * as odos from "./odos.ts";
import * as odosv2 from "./odosv2.ts";
import * as velora from "./velora.ts";
import * as matcha from "./matcha.ts";
import * as oneinch from "./oneinch.ts";
import * as uniswap from "./uniswap.ts";
import * as openocean from "./openocean.ts";
import * as cow from "./cow.ts";
import * as ophis from "./ophis.ts";
import * as delta from "./delta.ts";
import * as uniswapx from "./uniswapx.ts";
import * as fusion from "./fusion.ts";

export type { TradeSide } from "../trade_side.ts";

// Curve is lazy-loaded: its module-load side-effect (installCurveWorkerSilencer)
// patches globalThis.Blob, and a curve quote triggers a ~12s on-chain init that
// is fatal for serverless cold starts. Keeping it out of the static graph means
// a deployment that sets SWAP_DISABLE_VENUES=curve never pays the import cost,
// and the silencer only installs on first real use (before any init). Memoized.
type CurveModule = typeof import("./curve.ts");
let curveMod: CurveModule | undefined;
const loadCurve = async (): Promise<CurveModule> =>
  (curveMod ??= await import("./curve.ts"));

export {
  VENUES,
  VENUE_OPTIONS,
  ASYNC_VENUES,
  SYNC_VENUES,
  UnsupportedChainError,
  MissingApiKeyError,
  AsyncOptInRequiredError,
  UnsupportedSideError,
  isAsyncVenue,
} from "./types.ts";

const VENUE_ENV_VAR: Partial<Record<Venue, string>> = {
  matcha: "ZEROEX_API_KEY",
  "1inch": "ONEINCH_API_KEY",
  fusion: "ONEINCH_API_KEY",
  uniswapx: "UNISWAP_API_KEY",
  uniswap: "UNISWAP_API_KEY",
  // Not an API key: Ophis referral / rebate code. Gating on it keeps Ophis out of
  // -v all unless we'd actually earn the rebate (otherwise it's just CoW with
  // an extra fee that benefits no one).
  ophis: "OPHIS_REFERRAL_CODE",
};

export function requiredEnvVar(venue: Venue): string | null {
  return VENUE_ENV_VAR[venue] ?? null;
}

// Odos shut its app and API down for good on 2026-07-30 — every host
// (api.odos.xyz, enterprise-api.odos.xyz) now answers `530 Cloudflare Tunnel
// down`, so both the V3 (`odos`) and legacy V2 (`odosv2`) venues can only ever
// error. They're filtered out exactly like a venue whose API key is missing
// (silently absent from `-v all`), while an explicit `-v odos` fails loud with
// the reason. The adapters (odos.ts / odosv2.ts) are deliberately kept intact
// and still compile: flip this flag to false if Odos ever comes back.
const ODOS_DISCONTINUED = true;

function isDiscontinued(v: Venue): boolean {
  return ODOS_DISCONTINUED && (v === "odos" || v === "odosv2");
}

function assertNotDiscontinued(v: Venue): void {
  if (!isDiscontinued(v)) return;
  throw new Error(
    `Odos discontinued its app and API on 2026-07-30 — venue disabled (adapter kept for reference)`,
  );
}

// Venues explicitly disabled via SWAP_DISABLE_VENUES (CSV of venue names, e.g.
// "curve" on a serverless deployment where curve's ~12s on-chain init can't
// fit a cold start). A disabled venue is neither queried nor surfaced as
// "skipped" — it's wholly invisible. Unset → empty set → no behavior change.
export function disabledVenues(): Set<Venue> {
  const raw = process.env.SWAP_DISABLE_VENUES;
  if (!raw) return new Set();
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(VENUES.filter((v) => names.includes(v)));
}

// `side` (default "sell") narrows the set for exact-out: on side="buy" only
// BUY_CAPABLE_VENUES can quote (a sell-only venue would either error at the
// network boundary or, worse, return an inverted exact-in quote). The
// buy-capability filter is applied AFTER the async / api-key checks so a
// venue that's also missing its key / async-not-opted-in keeps its existing
// (more fundamental) skip reason instead of being relabelled sell-only.
export function availableVenues(opts: {
  allowAsync: boolean;
  side?: TradeSide;
}): Venue[] {
  const disabled = disabledVenues();
  const buy = opts.side === "buy";
  return VENUES.filter((v) => {
    if (disabled.has(v)) return false;
    if (isDiscontinued(v)) return false;
    if (isAsyncVenue(v) && !opts.allowAsync) return false;
    const envVar = VENUE_ENV_VAR[v];
    if (envVar && !process.env[envVar]) return false;
    if (buy && !isBuyCapable(v)) return false;
    return true;
  });
}

export type SkipReason =
  | { venue: Venue; reason: "api-key"; envVar: string }
  | { venue: Venue; reason: "async" }
  // Exact-out (side="buy") only: the venue is otherwise ready but has no
  // native buy path. Surfaced in the comparison block (unlike api-key,
  // which is a stderr note at race start, or async, which stays silent)
  // so `-v all --exact-out` explains why fewer venues competed.
  | { venue: Venue; reason: "sell-only" };

/** API-key skips for the CLI startup note. Drops ophis (referral code, not a key). */
export function missingApiKeySkips(opts: {
  allowAsync: boolean;
  venues?: Venue[];
}): Array<{ venue: Venue; envVar: string }> {
  const want = opts.venues ? new Set(opts.venues) : null;
  const out: Array<{ venue: Venue; envVar: string }> = [];
  for (const s of skippedVenues({ allowAsync: opts.allowAsync })) {
    if (s.reason !== "api-key") continue;
    if (!s.envVar.endsWith("_API_KEY")) continue;
    if (want && !want.has(s.venue)) continue;
    out.push({ venue: s.venue, envVar: s.envVar });
  }
  return out;
}

export function skippedVenues(opts: {
  allowAsync: boolean;
  side?: TradeSide;
}): SkipReason[] {
  const disabled = disabledVenues();
  const buy = opts.side === "buy";
  const out: SkipReason[] = [];
  for (const v of VENUES) {
    // Env-disabled venues are not "skipped" — they're absent entirely.
    if (disabled.has(v)) continue;
    // Same for a discontinued venue: there is no key to set, nothing to opt
    // into, so surfacing it as "skipped" would only be noise.
    if (isDiscontinued(v)) continue;
    if (isAsyncVenue(v) && !opts.allowAsync) {
      out.push({ venue: v, reason: "async" });
      continue;
    }
    const envVar = VENUE_ENV_VAR[v];
    if (envVar && !process.env[envVar]) {
      out.push({ venue: v, reason: "api-key", envVar });
      continue;
    }
    if (buy && !isBuyCapable(v)) {
      out.push({ venue: v, reason: "sell-only" });
    }
  }
  return out;
}

export type {
  NormalizedQuote,
  NormalizedHop,
  NormalizedTx,
  NormalizedOrder,
  NormalizedPermitTx,
  BuildResult,
  BuildTxParams,
  Eip712TypedData,
  Venue,
  SyncVenue,
  AsyncVenue,
  VenueOption,
  TokenHint,
} from "./types.ts";

export type VenueResult =
  | { venue: Venue; quote: NormalizedQuote }
  | { venue: Venue; error: string };

// `venues` (optional) restricts the set we query — typically the
// comma-separated list parsed from `-v kyber,odos,matcha`. Without it,
// we fall back to availableVenues (everything we can reach with the
// current env keys + allow-async setting). With it, we intersect the
// requested set with availableVenues so missing-key venues silently
// drop instead of returning an obtuse error from the dispatcher.
function resolveVenueList(opts: {
  allowAsync: boolean;
  side?: TradeSide;
  venues?: Venue[];
}): Venue[] {
  // `side` narrows the ready set for exact-out (buy): availableVenues drops
  // every sell-only venue. An explicit comma-list intersects with that set, so
  // a sell-only venue in `-v kyber,velora --exact-out` silently drops (mirrors
  // the missing-key / async skip). A single explicit sell-only venue never
  // reaches here (index.ts fetches it via runSingleVenue → fetchQuote, which
  // throws UnsupportedSideError).
  const ready = availableVenues({ allowAsync: opts.allowAsync, side: opts.side });
  if (!opts.venues) return ready;
  const readySet = new Set(ready);
  return opts.venues.filter((v) => readySet.has(v));
}

// Shared quote request shape. `side` defaults to "sell" (exact-in). For
// sell, `amountIn` is required; for buy (exact-out), `amountOut` is required.
// Venue BUY adapters land in later PRs — until then, buy requests reach
// sell-only adapters and fail at the network boundary (expected).
export type QuoteRequest = {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  slippageBps: number;
  side?: TradeSide;
  /** Fixed when side=sell (default). */
  amountIn?: bigint;
  /** Fixed when side=buy. */
  amountOut?: bigint;
  /**
   * Odos V2/V3 only (`--disableodosrfq` / dApp Advanced). Per-request so
   * concurrent serverless quotes cannot race the CLI module flag.
   */
  disableOdosRfq?: boolean;
};

/**
 * Lowest positive amountIn among successful buy quotes — seed for the sell
 * refine pass. null when no native buy venue produced a usable pay estimate.
 */
function bestBuySeedAmountIn(results: VenueResult[]): bigint | null {
  let best: bigint | null = null;
  for (const r of results) {
    if (!("quote" in r)) continue;
    try {
      const ain = BigInt(r.quote.amountIn);
      if (ain <= 0n) continue;
      if (best === null || ain < best) best = ain;
    } catch {
      // ignore unparseable
    }
  }
  return best;
}

/**
 * Sell-only venues that are otherwise ready (keys / async / not disabled) and
 * that should race the exact-out refine pass. Intersects with an explicit
 * venue filter when provided.
 */
function sellOnlyRefineVenues(opts: {
  allowAsync: boolean;
  venues?: Venue[];
}): Venue[] {
  const sellReady = availableVenues({ allowAsync: opts.allowAsync, side: "sell" });
  const sellOnly = sellReady.filter((v) => !isBuyCapable(v));
  if (!opts.venues) return sellOnly;
  const want = new Set(opts.venues);
  return sellOnly.filter((v) => want.has(v));
}

/**
 * Exact-out pass 2: quote sell-only venues as exact-in at `seedAmountIn` and
 * keep those whose amountOut meets the receive target. Tags survivors with
 * `buyRefine` so build enforces the min-out floor.
 */
async function refineSellOnlyForBuy(
  params: QuoteRequest & { allowAsync: boolean; venues?: Venue[] },
  seedAmountIn: bigint,
): Promise<VenueResult[]> {
  const target = params.amountOut;
  if (target == null || target <= 0n) return [];
  const venues = sellOnlyRefineVenues({
    allowAsync: params.allowAsync,
    venues: params.venues,
  });
  if (venues.length === 0) return [];

  const settled = await Promise.allSettled(
    venues.map((v) =>
      fetchQuote({
        venue: v,
        chain: params.chain,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: seedAmountIn,
        tokenInDecimals: params.tokenInDecimals,
        tokenOutDecimals: params.tokenOutDecimals,
        slippageBps: params.slippageBps,
        side: "sell",
        disableOdosRfq: params.disableOdosRfq,
      }),
    ),
  );

  return venues.map((venue, i): VenueResult => {
    const r = settled[i]!;
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { venue, error: msg };
    }
    const quote = r.value;
    let out: bigint;
    try {
      out = BigInt(quote.amountOut);
    } catch {
      return { venue, error: "sell refine: invalid amountOut" };
    }
    if (out < target) {
      return {
        venue,
        error: `sell refine below exact-out target (${out} < ${target})`,
      };
    }
    quote.buyRefine = {
      targetAmountOut: target.toString(),
      seedAmountIn: seedAmountIn.toString(),
    };
    return { venue, quote };
  });
}

export async function fetchAllQuotes(
  params: QuoteRequest & { allowAsync: boolean; venues?: Venue[] },
): Promise<VenueResult[]> {
  const { allowAsync, venues: requested, ...quoteParams } = params;
  const venues = resolveVenueList({ allowAsync, side: quoteParams.side, venues: requested });
  const settled = await Promise.allSettled(
    venues.map((v) => fetchQuote({ venue: v, ...quoteParams })),
  );
  const results: VenueResult[] = venues.map((venue, i): VenueResult => {
    const r = settled[i]!;
    if (r.status === "fulfilled") return { venue, quote: r.value };
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { venue, error: msg };
  });

  // Exact-out second pass: seed sell-only venues from the best native-buy pay
  // so the race is not limited to BUY_CAPABLE_VENUES.
  if (quoteParams.side === "buy" && quoteParams.amountOut != null) {
    const seed = bestBuySeedAmountIn(results);
    if (seed != null) {
      const refined = await refineSellOnlyForBuy(
        { ...quoteParams, allowAsync, venues: requested },
        seed,
      );
      results.push(...refined);
    }
  }

  return results;
}

// Same surface as fetchAllQuotes but yields each VenueResult as soon as
// its underlying fetchQuote settles, in arrival order (NOT in venue
// declaration order). Use this for live UX when you want the renderer to
// surface partial state — at the end, all venues will have been yielded
// exactly once. Internally backed by a tiny async queue: each fetchQuote
// promise pushes its outcome onto `queue` and wakes the consumer.
//
// On side=buy, phase 1 streams native buy-capable venues; once they all
// settle, phase 2 (sell refine) runs if a seed amountIn is available and
// those results are yielded afterward.
export async function* fetchAllQuotesStream(
  params: QuoteRequest & { allowAsync: boolean; venues?: Venue[] },
): AsyncGenerator<VenueResult> {
  const { allowAsync, venues: requested, ...quoteParams } = params;
  const venues = resolveVenueList({ allowAsync, side: quoteParams.side, venues: requested });
  const queue: VenueResult[] = [];
  let pending = venues.length;
  let waker: (() => void) | null = null;
  const wake = () => {
    const w = waker;
    waker = null;
    if (w) w();
  };

  // Collect buy-phase successes so we can seed the refine pass.
  const buyPhaseResults: VenueResult[] = [];

  for (const venue of venues) {
    fetchQuote({ venue, ...quoteParams })
      .then(
        (quote): VenueResult => ({ venue, quote }),
        (err: unknown): VenueResult => ({
          venue,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .then((result) => {
        buyPhaseResults.push(result);
        queue.push(result);
        pending--;
        wake();
      });
  }

  while (pending > 0 || queue.length > 0) {
    if (queue.length > 0) {
      yield queue.shift()!;
    } else {
      await new Promise<void>((resolve) => {
        waker = resolve;
      });
    }
  }

  // Phase 2 — sell refine (exact-out only).
  if (quoteParams.side === "buy" && quoteParams.amountOut != null) {
    const seed = bestBuySeedAmountIn(buyPhaseResults);
    if (seed != null) {
      const refined = await refineSellOnlyForBuy(
        { ...quoteParams, allowAsync, venues: requested },
        seed,
      );
      for (const r of refined) yield r;
    }
  }
}

/**
 * Rank successful quotes by side under `rank`.
 * Sell: max rankAmount. Buy: min rankAmount, then max gross amountOut.
 * Non-positive / unparseable rank keys sink (including sell zero-out).
 */
export function pickBest(
  results: VenueResult[],
  side: TradeSide,
  rank: RankMode,
): { best: { venue: Venue; quote: NormalizedQuote } | null; results: VenueResult[] } {
  type Row = { venue: Venue; quote: NormalizedQuote; rq: RankQuote };
  const rows: Row[] = [];
  for (const r of results) {
    if ("error" in r) continue;
    rows.push({
      venue: r.venue,
      quote: r.quote,
      rq: toRankQuote(r.quote, isAsyncVenue(r.venue)),
    });
  }
  const mode = effectiveRank(
    rows.map((row) => row.rq),
    rank,
  );
  let best: Row | null = null;
  for (const row of rows) {
    const key = rankAmount(row.rq, side, mode);
    if (positiveAmount(key) === null) continue;
    if (!best) {
      best = row;
      continue;
    }
    const cmp = compareBySide(key, rankAmount(best.rq, side, mode), side);
    if (cmp < 0) {
      best = row;
    } else if (cmp === 0 && side === "buy") {
      if (compareBySide(row.quote.amountOut, best.quote.amountOut, "sell") < 0) {
        best = row;
      }
    }
  }
  return {
    best: best ? { venue: best.venue, quote: best.quote } : null,
    results,
  };
}

export async function fetchQuote(
  params: QuoteRequest & { venue: Venue },
): Promise<NormalizedQuote> {
  const side = params.side ?? "sell";
  // A discontinued venue never reaches here from `-v all` (availableVenues
  // dropped it); this catches an explicit `-v odos` / `-v odosv2` and the
  // dApp's /api/route re-quote, and fails loud instead of surfacing Odos's
  // Cloudflare 530.
  assertNotDiscontinued(params.venue);
  // Defense in depth: exact-out (buy) only reaches venues with a native buy
  // path. Keyed on BUY_CAPABLE_VENUES (never adapter internals), thrown BEFORE
  // any network call so a sell-only venue can't emit an inverted exact-in quote
  // that would let the user pay an unbounded amountIn. The multi-venue paths
  // (-v all / comma-list) never send a sell-only venue here (resolveVenueList
  // already dropped it); this catches an explicit single `-v <sell-only>
  // --exact-out` and the dApp's /api/route + /api/build re-quote.
  if (side === "buy" && !isBuyCapable(params.venue)) {
    throw new UnsupportedSideError(params.venue);
  }
  assertQuoteAmount({
    side,
    amountIn: params.amountIn,
    amountOut: params.amountOut,
  });

  // Adapters still take sell-shaped `{ amountIn }` until BUY wiring lands.
  // For side=buy we pass amountIn=0n as a typed placeholder so the call
  // typechecks; adapters that ignore side will return nonsense or error
  // (acceptable until PR3+). Prefer amountIn when present (sell path).
  const adapterParams = {
    chain: params.chain,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn ?? 0n,
    tokenInDecimals: params.tokenInDecimals,
    tokenOutDecimals: params.tokenOutDecimals,
    slippageBps: params.slippageBps,
    side,
    amountOut: params.amountOut,
    disableOdosRfq: params.disableOdosRfq,
  };

  return withVenueTimeout(params.venue, async () => {
    switch (params.venue) {
      case "kyber":
        return kyber.quote(adapterParams);
      case "odos":
        return odos.quote(adapterParams);
      case "odosv2":
        return odosv2.quote(adapterParams);
      case "velora":
        return velora.quote(adapterParams);
      case "matcha":
        return matcha.quote(adapterParams);
      case "1inch":
        return oneinch.quote(adapterParams);
      case "curve":
        return (await loadCurve()).quote(adapterParams);
      case "uniswap":
        return uniswap.quote(adapterParams);
      case "openocean":
        return openocean.quote(adapterParams);
      case "cow":
        return cow.quote(adapterParams);
      case "ophis":
        return ophis.quote(adapterParams);
      case "delta":
        return delta.quote(adapterParams);
      case "uniswapx":
        return uniswapx.quote(adapterParams);
      case "fusion":
        return fusion.quote(adapterParams);
    }
  });
}

/**
 * When a quote carries `buyRefine`, the user intent is exact-out but the venue
 * only supports exact-in. Rewrite build params to sell + a slippage cap that
 * keeps minOut ≥ the original receive target.
 */
function buildParamsForQuote(params: BuildTxParams): BuildTxParams {
  const refine = params.quote?.buyRefine;
  if (!refine) return params;
  let target: bigint;
  let quotedOut: bigint;
  let payIn: bigint;
  try {
    target = BigInt(refine.targetAmountOut);
    quotedOut = BigInt(params.quote.amountOut);
    payIn = BigInt(params.quote.amountIn);
  } catch {
    throw new Error("buyRefine quote has invalid amount fields");
  }
  if (payIn <= 0n) {
    throw new Error("buyRefine quote missing positive amountIn");
  }
  if (quotedOut < target) {
    throw new Error(
      `buyRefine quote amountOut ${quotedOut} below target ${target}`,
    );
  }
  return {
    ...params,
    side: "sell",
    amountIn: payIn,
    amountOut: undefined,
    slippageBps: sellSlippageBpsForMinOutFloor(
      quotedOut,
      target,
      params.slippageBps,
    ),
  };
}

export async function build(
  venue: Venue,
  params: BuildTxParams,
): Promise<BuildResult> {
  assertNotDiscontinued(venue);
  // Sell-refine of exact-out: never call a sell-only adapter with side=buy.
  const p = buildParamsForQuote(params);
  switch (venue) {
    case "kyber":
      return { kind: "tx", ...(await kyber.buildTx(p)) };
    case "odos":
      return { kind: "tx", ...(await odos.buildTx(p)) };
    case "odosv2":
      return { kind: "tx", ...(await odosv2.buildTx(p)) };
    case "velora":
      return { kind: "tx", ...(await velora.buildTx(p)) };
    case "matcha":
      return { kind: "tx", ...(await matcha.buildTx(p)) };
    case "1inch":
      return { kind: "tx", ...(await oneinch.buildTx(p)) };
    case "curve":
      return { kind: "tx", ...(await (await loadCurve()).buildTx(p)) };
    case "uniswap":
      return uniswap.buildTx(p);
    case "openocean":
      return { kind: "tx", ...(await openocean.buildTx(p)) };
    case "cow":
      return cow.buildOrder(p);
    case "ophis":
      return ophis.buildOrder(p);
    case "delta":
      return delta.buildOrder(p);
    case "uniswapx":
      return uniswapx.buildOrder(p);
    case "fusion":
      return fusion.buildOrder(p);
  }
}

// Back-compat wrapper for callers that need the old NormalizedTx shape.
// Throws if the venue actually returned an order or a permit-tx — by
// definition only fully-built sync txs land here.
export async function buildTx(
  venue: Venue,
  params: BuildTxParams,
): Promise<NormalizedTx> {
  const result = await build(venue, params);
  if (result.kind === "order") {
    throw new Error(
      `buildTx called for async venue ${venue}; use build() instead`,
    );
  }
  if (result.kind === "permit-tx") {
    throw new Error(
      `buildTx called for ${venue} which requires a permit signature; use build() + assemblePermitTx()`,
    );
  }
  const { kind: _kind, ...tx } = result;
  return tx;
}

// Second leg of the Path A flow. After the user signs the typedData
// returned by build()'s permit-tx kind, the caller hands the signature
// (and the original quote — its raw response carries the permitData
// the signature was bound to) back here, and we POST to the venue's
// build endpoint to get a ready-to-broadcast tx.
export async function assemblePermitTx(params: {
  venue: NormalizedPermitTx["venue"];
  chain: ChainInfo;
  sender: string;
  signature: string;
  quote: NormalizedQuote;
}): Promise<NormalizedTx> {
  switch (params.venue) {
    case "uniswap":
      return uniswap.assemble(params);
    default:
      // Other sync venues hand-build calldata locally and never return
      // a permit-tx, so this branch should be unreachable.
      throw new Error(
        `assemblePermitTx not implemented for venue ${params.venue}`,
      );
  }
}

// Tear down any persistent resources venues have set up. Today only
// curve owns one (an ethers JsonRpcProvider whose poller would
// otherwise keep the event loop alive past program completion). We only
// touch curve if it was actually loaded — never import it just to clean up
// (that would defeat the lazy-load and pay the module-load cost regardless).
export async function shutdown(): Promise<void> {
  if (curveMod) await curveMod.cleanup();
}

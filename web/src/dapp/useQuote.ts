import { useCallback, useEffect, useRef, useState } from "react";
import { streamQuote, sessionId } from "./api";
import { toNumber } from "./venues";
import { warmCurve, quoteCurve, curveSupportedChain } from "./curve/client";
import { curveGasUsd, estimateCurveGasUnits } from "./curve/gas";
import { gasPriceWeiFor } from "./curve/gasPrice";
import { fetchUsdPrices } from "./cgPrices";
import {
  rankModeFromFetched,
  rankRoutesBySide,
  toExecution,
} from "../../../shared/rank";
import type {
  ChainMeta,
  QuoteRequest,
  QuoteResponse,
  QuoteStreamEvent,
  RawRoute,
  RouteHop,
  TokenInfo,
  TradeSide,
} from "./types";

// Which amount field is the active input. pay = exact-in (sell, the historical
// default); receive = exact-out (buy). Typing in a field makes it active.
export type EditSide = "pay" | "receive";

// The native-token sentinel address shared across the whole system (KyberSwap
// convention). The dApp uses it to detect wrap/unwrap (native ↔ wrapped-native)
// pairs that skip the aggregator entirely.
export const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// Debounce + auto-refresh timings. Inputs settle for ~400ms before a quote
// fires; a fresh quote is re-pulled every ~20s to track price movement.
const DEBOUNCE_MS = 400;
const REFRESH_MS = 20_000;
export const MANUAL_LOCK_MS = 3_000;

export function shouldAutoRefresh(args: {
  visible: boolean;
  now: number;
  expiresAt: number | null;
  pendingWhileHidden: boolean;
  firedForExpiresAt: number | null;
  source: "timer" | "visible";
}): boolean {
  if (!args.visible) return false;
  if (args.expiresAt != null) {
    if (args.now < args.expiresAt) return false;
    return args.firedForExpiresAt !== args.expiresAt;
  }
  if (args.source === "timer") return true;
  return args.pendingWhileHidden;
}

export function upsertRawRoute(raw: RawRoute[], route: RawRoute): void {
  const i = raw.findIndex((r) => r.venue === route.venue);
  if (i >= 0) raw[i] = route;
  else raw.push(route);
}

export function removeRawVenue(raw: RawRoute[], venue: string): void {
  const i = raw.findIndex((r) => r.venue === venue);
  if (i >= 0) raw.splice(i, 1);
}

export function seedRawRoutes(
  lastRaw: RawRoute[] | null,
  previous: QuoteResponse | null,
): RawRoute[] {
  if (lastRaw && lastRaw.length > 0) return lastRaw.map((r) => ({ ...r }));
  if (!previous || previous.routes.length === 0) return [];
  return previous.routes.map((r) => ({
    ...r,
    amountInUsd: null,
    amountOutUsd: null,
  }));
}

export function shouldKeepPrevious(args: {
  purge: boolean;
  reqKey: string;
  lastKey: string | null;
  hasQuote: boolean;
  lastRawLen: number;
}): boolean {
  if (args.purge) return false;
  if (args.reqKey !== args.lastKey) return false;
  return args.hasQuote || args.lastRawLen > 0;
}

// One of the three "no-routing" shapes the form can be in. `swap` is a real DEX
// route (hits /api/quote); `wrap`/`unwrap` are the native↔wrapped short-circuit
// (1:1, synthesized locally, no quote); `send` is a transfer (also no quote).
export type FormMode = "swap" | "wrap" | "unwrap" | "send";

// Convert a human-typed amount (e.g. "1.25") into base-units (e.g. "1250000")
// for the given decimals. Returns null when the string isn't a clean,
// strictly-positive number — callers treat null as "incomplete, don't quote".
export function toBaseUnits(human: string, decimals: number): string | null {
  const trimmed = human.trim();
  if (trimmed === "") return null;
  if (!/^\d*\.?\d*$/.test(trimmed)) return null;
  const [whole = "", fracRaw = ""] = trimmed.split(".");
  if (whole === "" && fracRaw === "") return null;
  // Truncate (don't round) excess fractional digits — matches base-unit floor.
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const wholePart = whole === "" ? "0" : whole;
  let combined = (wholePart + frac).replace(/^0+/, "");
  if (combined === "") combined = "0";
  if (combined === "0") return null; // zero amount → nothing to quote
  return combined;
}

// Detect the form mode from the active pair. wrap/unwrap is the native↔wrapped
// pair (in either direction); send is signalled by the caller (it's a UI tab,
// not derivable from the pair). Everything else is a real swap.
export function detectMode(args: {
  chain: ChainMeta;
  tokenIn: TokenInfo | null;
  tokenOut: TokenInfo | null;
  isSend: boolean;
}): FormMode {
  if (args.isSend) return "send";
  const { chain, tokenIn, tokenOut } = args;
  if (!tokenIn || !tokenOut) return "swap";
  const inLc = tokenIn.address.toLowerCase();
  const outLc = tokenOut.address.toLowerCase();
  const wrapped = chain.wrappedNative.toLowerCase();
  const native = NATIVE_SENTINEL;
  if (inLc === native && outLc === wrapped) return "wrap";
  if (inLc === wrapped && outLc === native) return "unwrap";
  return "swap";
}

export type UseQuoteArgs = {
  chain: ChainMeta;
  tokenIn: TokenInfo | null;
  tokenOut: TokenInfo | null;
  // The active amount the user typed (human units). It denominates the PAY side
  // (tokenIn) when editSide==="pay" (sell / exact-in) and the RECEIVE side
  // (tokenOut) when editSide==="receive" (buy / exact-out).
  amount: string;
  editSide: EditSide;
  slippageBps: number;
  allowAsync: boolean;
  enabledVenues: string[]; // venue names the user left switched on
  allVenueCount: number; // total venues available (to decide if a filter is in effect)
  isSend: boolean; // the Send tab is active → no quote needed
  // True when the server does NOT offer curve (curve absent from /api/mode's
  // venues — the Vercel stateless deployment with SWAP_DISABLE_VENUES=curve).
  // Gates the in-browser curve client: on the local server, where curve is
  // server-side, this is false and the client stays inactive (no duplicate row).
  serverHasCurve: boolean;
  // CLI --disableodosrfq / Settings → Advanced: odos/odosv2 disableRFQs.
  disableOdosRfq?: boolean;
};

export type UseQuoteResult = {
  quote: QuoteResponse | null;
  loading: boolean;
  // True while a same-input re-quote is in flight. Manual and auto refresh
  // blank the list first. Distinct from `loading`, which is the first-quote
  // empty state.
  refreshing: boolean;
  // True from stream start until every venue has settled (the `done` event).
  // Drives the refresh spinner so it spins until all quotes are received.
  streaming: boolean;
  error: string | null;
  mode: FormMode;
  // A locally-synthesized 1:1 amount-out (base-units) for wrap/unwrap, so the
  // form can show "you receive" without a backend round-trip. null for swap/send.
  synthAmountOut: string | null;
  refresh: () => void;
  // True for MANUAL_LOCK_MS after stream `done`. Independent of `streaming`.
  refreshLocked: boolean;
  // Seconds until the live quote expires (from QuoteResponse.expiresAt). null
  // when there is no quote or no expiry.
  secondsToExpiry: number | null;
  // The route hops of the current round's client-side curve quote (for the
  // RouteGraph). null when curve didn't produce a route this round. The
  // orchestrator uses these to build a RouteGraphResponse locally instead of
  // calling /api/route for a clientSide venue.
  curveRouteHops: RouteHop[] | null;
};

// useQuote — owns the quote lifecycle for the interactive swap form.
//
//   · debounces the form inputs ~400ms, converts the amount to base units, and
//     POSTs /api/quote (no wallet needed);
//   · auto-refreshes every ~20s while the inputs are stable;
//   · short-circuits wrap/unwrap (native↔wrapped 1:1) and send to NOT hit the
//     backend — those have no routing — and instead exposes a synthesized 1:1
//     amount-out (wrap/unwrap) for display;
//   · skips entirely when the pair is incomplete or the amount is zero.
export function useQuote(args: UseQuoteArgs): UseQuoteResult {
  const {
    chain,
    tokenIn,
    tokenOut,
    amount,
    editSide,
    slippageBps,
    allowAsync,
    enabledVenues,
    allVenueCount,
    isSend,
    serverHasCurve,
    disableOdosRfq = false,
  } = args;

  const sid = sessionId();
  const mode = detectMode({ chain, tokenIn, tokenOut, isSend });

  // Trade side: exact-out (buy) only when the receive field is active AND we're
  // in a real swap. wrap/unwrap/send are always exact-in (buy is out of scope
  // there — the receive field stays read-only, see SwapForm).
  const side: TradeSide = mode === "swap" && editSide === "receive" ? "buy" : "sell";
  // The token whose decimals denominate the ACTIVE amount: tokenIn on sell,
  // tokenOut on buy.
  const activeToken = side === "buy" ? tokenOut : tokenIn;

  // In-browser curve activation (the three-part rule from the design):
  //   (a) the server doesn't offer curve (serverHasCurve === false),
  //   (b) the current chain is curve-supported, and
  //   (c) the user left the "curve" venue toggle on.
  // When all three hold we run quoteCurve in parallel with each server round and
  // merge its route in. enabledVenues drives (c): the synthetic curve VenueMeta
  // is added to the settings list by the orchestrator, so toggling it lands in
  // enabledVenues like any other venue. (When NO venue filter is in effect —
  // enabledVenues spans every venue — curve is implicitly on too.)
  // curve-js is sell-only in our integration — never inject the client-side
  // curve route on a buy (exact-out) round (it has no exact-out path here).
  const curveActive =
    side === "sell" &&
    !serverHasCurve &&
    curveSupportedChain(chain.chainId) &&
    enabledVenues.includes("curve");

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // True during a same-input re-quote. Manual and auto refresh blank the
  // list first.
  const [refreshing, setRefreshing] = useState(false);
  // True from the moment a quote stream starts until ALL venues have settled
  // (the `done` event) — distinct from `loading`, which flips false on the first
  // route so the form goes interactive. Drives the refresh spinner so it keeps
  // spinning until every quote is in.
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The current round's client-side curve route hops (for the RouteGraph), or
  // null when curve didn't quote this round. Set when the curve fetch resolves
  // for the still-current round; cleared at the start of every new round.
  const [curveRouteHops, setCurveRouteHops] = useState<RouteHop[] | null>(null);
  // Bumped by refresh() to force a re-quote even when inputs are unchanged.
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [refreshLocked, setRefreshLocked] = useState(false);
  const refreshLockedRef = useRef(false);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiresAtRef = useRef<number | null>(null);
  const firedForExpiresAtRef = useRef<number | null>(null);
  const pendingWhileHiddenRef = useRef(false);
  expiresAtRef.current = quote?.expiresAt ?? null;

  const armManualLock = useCallback(() => {
    refreshLockedRef.current = true;
    setRefreshLocked(true);
    if (lockTimerRef.current != null) clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => {
      refreshLockedRef.current = false;
      setRefreshLocked(false);
      lockTimerRef.current = null;
    }, MANUAL_LOCK_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (lockTimerRef.current != null) clearTimeout(lockTimerRef.current);
    };
  }, []);

  // Mirrors of the latest quote + last request key, read synchronously by the
  // debounce effect. A changed key or a purge (manual / auto refresh) streams
  // from empty.
  const quoteRef = useRef<QuoteResponse | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const lastRawRef = useRef<RawRoute[] | null>(null);
  const purgeListRef = useRef(false);
  useEffect(() => {
    quoteRef.current = quote;
  }, [quote]);

  // base-units of the ACTIVE amount, in the active token's decimals (tokenIn on
  // sell, tokenOut on buy). Recomputed each render (cheap, deterministic).
  const baseUnits = activeToken ? toBaseUnits(amount, activeToken.decimals) : null;

  // A quote is needed only for real swaps with a complete, positive pair.
  const needsQuote =
    mode === "swap" &&
    !!tokenIn &&
    !!tokenOut &&
    !!baseUnits &&
    tokenIn.address.toLowerCase() !== tokenOut.address.toLowerCase();

  // Synthesize the 1:1 output for wrap/unwrap (base-units == input base-units).
  // wrap/unwrap are always sell, so baseUnits is the tokenIn amount here.
  const synthAmountOut =
    (mode === "wrap" || mode === "unwrap") && baseUnits ? baseUnits : null;

  // Build the venues[] filter only when the user has actually narrowed the set
  // (some off). When every venue is on, omit the field so the backend uses its
  // full default set.
  const venuesFilter =
    enabledVenues.length > 0 && enabledVenues.length < allVenueCount
      ? [...enabledVenues].sort()
      : undefined;

  // Stable key over everything that should trigger a re-quote. JSON of the
  // request-relevant fields; the debounce effect depends on it.
  const reqKey = needsQuote
    ? JSON.stringify({
        chain: chain.alias,
        tin: tokenIn!.address.toLowerCase(),
        tout: tokenOut!.address.toLowerCase(),
        side,
        amt: baseUnits,
        slip: slippageBps,
        async: allowAsync,
        venues: venuesFilter ?? null,
        noOdosRfq: disableOdosRfq || null,
      })
    : null;

  // Latest in-flight stream: a monotonic seq discards late events from a
  // superseded request, and an AbortController cancels the HTTP stream itself.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const runQuote = useCallback(
    async (_key: string, keepPrevious: boolean) => {
      if (!tokenIn || !tokenOut || !baseUnits) return;
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setError(null);
      // New round → drop the previous round's curve hops; they re-arrive only if
      // curve quotes this round (so the curve row never goes stale across rounds).
      setCurveRouteHops(null);
      setStreaming(true); // stays true until `done` (all venues settled)
      // Fresh quote and refresh (manual or auto) stream from empty.
      if (keepPrevious) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setQuote(null);
      }

      const req: QuoteRequest = {
        chain: chain.alias,
        tokenInAddress: tokenIn.address,
        tokenOutAddress: tokenOut.address,
        // Exactly one of amountIn / amountOut. On buy the fixed leg is the
        // tokenOut amount and we tag side so the server picks the exact-out path.
        ...(side === "buy"
          ? { amountOut: baseUnits, side: "buy" as const }
          : { amountIn: baseUnits }),
        slippageBps,
        allowAsync,
        ...(venuesFilter ? { venues: venuesFilter } : {}),
        // Only send when on — keeps the wire minimal and matches the CLI default.
        ...(disableOdosRfq ? { disableOdosRfq: true } : {}),
      };

      // Accumulate streamed events; rebuild the QuoteResponse on each route so
      // the UI shows routes (and the best-so-far output) live.
      let meta: Extract<QuoteStreamEvent, { type: "meta" }> | null = null;
      const raw: RawRoute[] = keepPrevious
        ? seedRawRoutes(lastRawRef.current, quoteRef.current)
        : [];
      const settled = new Set<string>();
      // Venues that errored (e.g. intent venues reject native-ETH input). Kept
      // so the routes pane can surface them muted instead of dropping silently.
      const errs: { venue: string; reason: string }[] = [];
      // Read `meta` through a getter so closures invoked later (the curve IIFE)
      // see its DECLARED union type, not the null its control-flow-narrowed
      // capture would otherwise collapse to.
      const metaOf = (): Extract<QuoteStreamEvent, { type: "meta" }> | null => meta;
      let nativeUsd: number | null = null;
      let tokenInUsdSpot: number | null = null;
      let tokenOutUsdSpot: number | null = null;
      void fetchUsdPrices(chain.chainId, [
        NATIVE_SENTINEL,
        tokenIn.address.toLowerCase(),
        tokenOut.address.toLowerCase(),
      ])
        .then((m) => {
          if (seq !== seqRef.current) return;
          nativeUsd = m.get(NATIVE_SENTINEL) ?? null;
          tokenInUsdSpot = m.get(tokenIn.address.toLowerCase()) ?? null;
          tokenOutUsdSpot = m.get(tokenOut.address.toLowerCase()) ?? null;
          const q = rebuild();
          if (q) setQuote(q);
        })
        .catch((e) => {
          console.warn("useQuote: fetchUsdPrices failed", e);
        });
      const rebuild = (expiresAt?: number): QuoteResponse | null => {
        if (!meta || raw.length === 0) return null;
        const rank = rankModeFromFetched({
          side,
          nativeUsd,
          tokenInUsd: tokenInUsdSpot,
          tokenOutUsd: tokenOutUsdSpot,
          tokenInDecimals: meta.tokenIn.decimals,
          tokenOutDecimals: meta.tokenOut.decimals,
        });
        const sorted = rankRoutesBySide(
          raw.map((r) => ({
            ...r,
            execution: toExecution(
              r.kind,
              r.gasUnits ?? null,
              r.gasPriceWei ?? null,
            ),
          })),
          side,
          rank,
        );
        const top = sorted[0]!;
        // Resolve the response amounts: the FIXED leg comes from meta (the user's
        // request), the VARIABLE leg from the best route. sell fixes amountIn and
        // reports the best amountOut; buy fixes amountOut and reports the best
        // (lowest) amountIn.
        const respAmountIn = side === "buy" ? top.amountIn : meta.amountIn!;
        const respAmountOut = side === "buy" ? meta.amountOut! : top.amountOut;
        const humanIn = toNumber(respAmountIn, meta.tokenIn.decimals);
        const humanOut = toNumber(respAmountOut, meta.tokenOut.decimals);
        const tokenInUsd = top.amountInUsd != null && humanIn > 0 ? top.amountInUsd / humanIn : null;
        const tokenOutUsd = top.amountOutUsd != null && humanOut > 0 ? top.amountOutUsd / humanOut : null;
        const rate =
          humanIn > 0
            ? `1 ${meta.tokenIn.symbol} = ${(humanOut / humanIn).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${meta.tokenOut.symbol}`
            : "";
        lastRawRef.current = raw.map((r) => ({ ...r }));
        return {
          quoteId: meta.quoteId,
          side,
          chain: meta.chain,
          tokenIn: meta.tokenIn,
          tokenOut: meta.tokenOut,
          amountIn: respAmountIn,
          amountOut: respAmountOut,
          best: { venue: top.venue, amountIn: top.amountIn, amountOut: top.amountOut },
          // strip the per-route USD before exposing the display shape
          routes: sorted.map(
            ({ amountInUsd: _a, amountOutUsd: _b, execution: _e, ...r }) => r,
          ),
          unavailable: errs.length > 0 ? [...errs] : undefined,
          tokenInUsd,
          tokenOutUsd,
          rate,
          expiresAt: expiresAt ?? meta.expiresAt,
        };
      };

      // ---- in-browser curve, in parallel with the server stream ----
      // When active, warm the per-chain curve-js init (idempotent) then quote
      // with the SAME pair/amount as this round. curve-js init is ~12s cold, so
      // this almost always resolves AFTER the server's `done`; we inject the
      // route then and rebuild() (re-sorting + re-deriving best) regardless of
      // keepPrevious. The seq guard discards the result if the round was
      // superseded while we were initializing/quoting — no stale curve row.
      if (curveActive) {
        const cIn = { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals };
        const cOut = { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals };
        const cAmount = baseUnits;
        void (async () => {
          // console.debug breadcrumbs (verbose-only in devtools): this path runs
          // unattended in visitors' tabs and every early-return is silent by
          // design — without these, "curve never shows up" is undiagnosable.
          try {
            const ok = await warmCurve(chain.chainId);
            if (seq !== seqRef.current) {
              console.debug(`curve client: round ${seq} superseded during init — skipping quote`);
              return;
            }
            if (!ok) return; // curve unavailable on this chain — warmCurve already warned
            console.debug(`curve client: quoting round ${seq}`);
            const [cq, curveGasPriceWei] = await Promise.all([
              quoteCurve({
                chainId: chain.chainId,
                tokenIn: cIn,
                tokenOut: cOut,
                amountIn: cAmount,
              }),
              gasPriceWeiFor(chain.chainId),
            ]);
            if (seq !== seqRef.current) {
              console.debug(`curve client: round ${seq} superseded while quoting — result discarded`);
              return;
            }
            if (!cq) {
              console.debug(`curve client: round ${seq} yielded no route — skipping`);
              return;
            }
            // A warm curve quote resolves in milliseconds — typically BEFORE the
            // server stream has emitted this round's `meta` line. Wait for it
            // (bounded by the round staying current) instead of dropping the
            // route, or every refresh would eject the curve row again.
            let m = metaOf();
            while (!m && seq === seqRef.current) {
              await new Promise((r) => setTimeout(r, 150));
              m = metaOf();
            }
            if (seq !== seqRef.current) {
              console.debug(`curve client: round ${seq} superseded awaiting meta — result discarded`);
              return;
            }
            if (!m) return; // unreachable (loop exits on meta or stale seq)
            // Derive curve's whole-amount USD from any server route's per-unit
            // USD that has already arrived (curve-js exposes no USD itself). When
            // no server route carries USD yet, leave both null → priceImpact null.
            const ref = raw.find((r) => r.amountInUsd != null && r.amountOutUsd != null);
            // curve is sell-only here (curveActive gates on side==="sell"), so
            // the meta line always carries amountIn — the fixed input leg.
            const metaIn = m.amountIn!;
            const humanIn = toNumber(metaIn, m.tokenIn.decimals);
            const humanOut = toNumber(cq.amountOut, m.tokenOut.decimals);
            let amountInUsd: number | null = null;
            let amountOutUsd: number | null = null;
            let priceImpactPct: number | null = null;
            if (ref) {
              const refHumanIn = toNumber(metaIn, m.tokenIn.decimals);
              const refHumanOut = toNumber(ref.amountOut, m.tokenOut.decimals);
              const inUsdPerUnit = refHumanIn > 0 ? ref.amountInUsd! / refHumanIn : null;
              const outUsdPerUnit = refHumanOut > 0 ? ref.amountOutUsd! / refHumanOut : null;
              if (inUsdPerUnit != null) amountInUsd = inUsdPerUnit * humanIn;
              if (outUsdPerUnit != null) amountOutUsd = outUsdPerUnit * humanOut;
              if (amountInUsd != null && amountOutUsd != null && amountInUsd > 0) {
                priceImpactPct = ((amountOutUsd - amountInUsd) / amountInUsd) * 100;
              }
            }
            const curveRoute: RawRoute = {
              venue: "curve",
              // sell round → every route shares the fixed tokenIn amount.
              amountIn: metaIn,
              amountOut: cq.amountOut,
              gasUsd: curveGasUsd({
                hops: cq.routeHops,
                nativeSymbol: chain.nativeSymbol,
                gasPriceWei: curveGasPriceWei,
              }),
              priceImpactPct,
              kind: "sync",
              gasUnits: estimateCurveGasUnits(cq.routeHops),
              gasPriceWei: curveGasPriceWei?.toString() ?? null,
              clientSide: true,
              amountInUsd,
              amountOutUsd,
            };
            upsertRawRoute(raw, curveRoute);
            settled.add("curve");
            console.debug(`curve client: round ${seq} merged (${cq.amountOutHuman} out)`);
            setCurveRouteHops(cq.routeHops);
            const q = rebuild();
            if (q) {
              // Curve may be the ONLY route on a sparse chain where every server
              // venue missed — in that case `done` already set the "no route"
              // error; clear it now that we have a usable curve route.
              setError(null);
              setQuote(q);
              setLoading(false);
            }
          } catch (e) {
            // warmCurve/quoteCurve are documented to console.warn + resolve
            // (never throw), but guard anyway so a curve failure never disturbs
            // the server stream. Just log and leave the curve row absent.
            console.warn("useQuote: client-side curve quote failed", e);
          }
        })();
      }

      try {
        await streamQuote(
          sid,
          req,
          (ev) => {
            if (seq !== seqRef.current) return; // superseded
            if (ev.type === "meta") {
              meta = ev;
            } else if (ev.type === "route") {
              upsertRawRoute(raw, ev.route);
              settled.add(ev.route.venue);
              const q = rebuild();
              if (q) {
                setQuote(q);
                setLoading(false); // first usable route → form goes interactive
              }
            } else if (ev.type === "done") {
              for (let i = raw.length - 1; i >= 0; i--) {
                if (!settled.has(raw[i]!.venue)) raw.splice(i, 1);
              }
              lastRawRef.current = raw.map((r) => ({ ...r }));
              const q = rebuild(ev.expiresAt);
              if (q) {
                setQuote(q);
                armManualLock();
              } else if (!keepPrevious) setError("no route found for this pair");
              setLoading(false);
              setRefreshing(false);
              setStreaming(false); // all venues settled
            } else if (ev.type === "fatal") {
              if (!keepPrevious) {
                setError(ev.error);
                setQuote(null);
              } else {
                // Keep the last good quote on a failed refresh; just log it.
                console.error("useQuote: refresh fatal —", ev.error);
              }
              setLoading(false);
              setRefreshing(false);
              setStreaming(false);
            } else if (ev.type === "verror") {
              // A single venue failed — non-fatal. Drop its row (including a
              // seeded leftover) so a timeout disappears as soon as it errors.
              removeRawVenue(raw, ev.venue);
              errs.push({ venue: ev.venue, reason: ev.error });
              settled.add(ev.venue);
              const q = rebuild();
              if (q) setQuote(q);
            }
          },
          ac.signal,
        );
        if (seq === seqRef.current) {
          setLoading(false);
          setRefreshing(false);
          setStreaming(false); // safety: stream ended without a `done` event
        }
      } catch (e) {
        if (ac.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
        if (seq !== seqRef.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error("useQuote: streamQuote failed", e);
        if (!keepPrevious) {
          setError(msg);
          setQuote(null);
        }
        setLoading(false);
        setRefreshing(false);
        setStreaming(false);
      }
    },
    [sid, chain.alias, chain.chainId, tokenIn, tokenOut, side, baseUnits, slippageBps, allowAsync, venuesFilter, curveActive, disableOdosRfq, armManualLock],
  );

  // Debounced fetch on input changes (+ explicit refresh via `nonce`). When the
  // form isn't quotable, clear any stale quote/error.
  useEffect(() => {
    if (!needsQuote || !reqKey) {
      // Cancel any in-flight stream and reset the displayed quote.
      seqRef.current++;
      abortRef.current?.abort();
      setQuote(null);
      setLoading(false);
      setRefreshing(false);
      setStreaming(false);
      setError(null);
      lastKeyRef.current = null;
      lastRawRef.current = null;
      purgeListRef.current = false;
      return;
    }
    // A changed key streams from empty. Manual and auto refresh set purge
    // so the list blanks first.
    const purge = purgeListRef.current;
    purgeListRef.current = false;
    const keepPrevious = shouldKeepPrevious({
      purge,
      reqKey,
      lastKey: lastKeyRef.current,
      hasQuote: quoteRef.current != null,
      lastRawLen: lastRawRef.current?.length ?? 0,
    });
    lastKeyRef.current = reqKey;
    const handle = setTimeout(() => {
      void runQuote(reqKey, keepPrevious);
    }, purge ? 0 : DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // reqKey collapses all request-relevant inputs; nonce forces a rerun.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, nonce, needsQuote]);

  const beginPurgingRound = useCallback(() => {
    seqRef.current++;
    abortRef.current?.abort();
    purgeListRef.current = true;
    lastRawRef.current = null;
    quoteRef.current = null;
    setQuote(null);
    setCurveRouteHops(null);
    setError(null);
    setStreaming(true);
    setRefreshing(true);
    setNonce((n) => n + 1);
  }, []);

  // Auto-refresh at quote.expiresAt (REFRESH_MS fallback). Hidden tabs skip
  // the fire; a skipped fire never reschedules (expiresAt unchanged), so
  // visibilitychange has to catch up. Same purge-then-stream as the button.
  useEffect(() => {
    if (!needsQuote) {
      pendingWhileHiddenRef.current = false;
      return;
    }

    const autoFire = (source: "timer" | "visible") => {
      const visible = document.visibilityState === "visible";
      const expiresAt = expiresAtRef.current;
      if (!visible) {
        if (source === "timer") pendingWhileHiddenRef.current = true;
        return;
      }
      if (
        !shouldAutoRefresh({
          visible: true,
          now: Date.now(),
          expiresAt,
          pendingWhileHidden: pendingWhileHiddenRef.current,
          firedForExpiresAt: firedForExpiresAtRef.current,
          source,
        })
      ) {
        return;
      }
      if (expiresAt != null) firedForExpiresAtRef.current = expiresAt;
      pendingWhileHiddenRef.current = false;
      beginPurgingRound();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") autoFire("visible");
    };
    document.addEventListener("visibilitychange", onVisibility);

    const exp = quote?.expiresAt;
    if (!exp) {
      const id = setInterval(() => autoFire("timer"), REFRESH_MS);
      return () => {
        clearInterval(id);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    }
    const delay = Math.max(0, exp - Date.now());
    const id = setTimeout(() => autoFire("timer"), delay);
    return () => {
      clearTimeout(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [needsQuote, quote?.expiresAt, beginPurgingRound]);

  // Tick a clock once per second so secondsToExpiry counts down live. Only runs
  // while there's a quote with an expiry.
  useEffect(() => {
    if (!quote || !quote.expiresAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quote]);

  const refresh = useCallback(() => {
    if (refreshLockedRef.current) return;
    beginPurgingRound();
  }, [beginPurgingRound]);

  const secondsToExpiry =
    quote && quote.expiresAt
      ? Math.max(0, Math.round((quote.expiresAt - now) / 1000))
      : null;

  return {
    quote: needsQuote ? quote : null,
    loading,
    refreshing,
    streaming,
    error,
    mode,
    synthAmountOut,
    refresh,
    refreshLocked,
    secondsToExpiry,
    curveRouteHops: needsQuote ? curveRouteHops : null,
  };
}

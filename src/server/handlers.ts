// Stateless request handlers for the interactive swap dApp.
//
// Each handler is `(req: Request) => Promise<Response>` (or a synchronous
// metadata responder) built on the Web Fetch API ONLY — no `Bun.*`. The same
// handlers back both runtimes:
//   • src/serve.ts  — wraps them in a long-lived Bun.serve()
//   • api/*.ts      — one Vercel serverless function per route
//
// The defining difference from the old serve.ts is that there is NO server
// memory: no quote cache, no pendingPermit, no pendingOrder. Vercel functions
// are independent cold-startable invocations, so every handler reconstructs
// its inputs from the request body. The logic is otherwise migrated verbatim
// from serve.ts; only the state plumbing is gone.
//
// Imports are constrained to Bun-free modules: src/server/shared.ts (the
// Payload/proxy/rewrite helpers extracted out of browser.ts), core.ts,
// chains.ts, tokens.ts, amount.ts, checksum.ts, venues/index.ts.

import { randomBytes } from "node:crypto";
import type { ChainInfo } from "../chains.ts";
import { resolveChain } from "../chains.ts";
import { NATIVE_SENTINEL, isAddress, type Token } from "../tokens.ts";
import { fromBaseUnits } from "../amount.ts";
import { toChecksumAddress } from "../checksum.ts";
import {
  parseWireQuoteAmounts,
  isBuyCapable,
  BUY_CAPABLE_VENUES,
  type TradeSide,
} from "../trade_side.ts";
import { GROSS, sortRoutesBySide, toExecution } from "../../shared/rank.ts";
import { maxAmountIn } from "../slippage.ts";
import {
  VENUES,
  disabledVenues,
  isAsyncVenue,
  UnsupportedSideError,
  type Venue,
  type NormalizedQuote,
  type NormalizedHop,
  type NormalizedOrder,
  type BuildResult,
  type TokenHint,
} from "../venues/index.ts";
import {
  resolveTokenPair,
  resolveOneToken,
  tokenList,
  quoteAll,
  quoteAllStream,
  quoteSingle,
  buildForVenue,
  checkAllowance,
  inputPaidViaValue,
  needsAllowanceCheck,
  assemble as coreAssemble,
  resolveRouteHops,
  listChains,
  listVenues,
} from "../core.ts";
import {
  API_VERSION,
  withFromFallback,
  rewriteAuthedOrderSubmit,
  proxyOrderSubmit,
  type Payload,
  type ApprovalForBrowser,
} from "./shared.ts";
import { parseDoneReport, doneEventLine } from "./done_report.ts";
import { setReferralMode } from "../referral.ts";
import { setPublicRpcFallback } from "../rpc.ts";

setReferralMode("dapp");
setPublicRpcFallback(true);

// Quotes are no longer cached server-side; the quoteId is a client-held key
// (it groups a streaming round in the UI) and the expiresAt is purely a UI
// hint. The TTL matches the old serve.ts so the page's refresh cadence is
// unchanged.
const QUOTE_TTL_MS = 30_000;

// Token wire shape: the front-end sends fully-resolved token metadata on
// /api/route and /api/build, so neither handler does a network resolution at
// build/route time. The native sentinel is a valid address here.
export type WireToken = {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
};

// ───────────────────────────── response helpers ─────────────────────────

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function errRes(message: string, status = 400): Response {
  return jsonRes({ error: message }, status);
}

// Per-unit USD from a venue quote that carries whole-amount USD.
function perUnitUsd(amountUsd: number | null, amountBase: string, decimals: number): number | null {
  if (amountUsd == null) return null;
  const human = Number(fromBaseUnits(amountBase, decimals, 18));
  if (!Number.isFinite(human) || human === 0) return null;
  return amountUsd / human;
}

// Rebuild a Token from the client-supplied wire shape + the resolved chain.
// SAFETY-CRITICAL: decimals must be exact (a wrong value rescales the amount
// by 10^N and corrupts calldata), so we validate rather than coerce. We never
// hit the network here — the front-end already resolved the token via
// /api/tokens or /api/resolve-token, so trusting its metadata is correct AND
// avoids a redundant lookup on every build.
function tokenFromWire(w: WireToken | undefined, chain: ChainInfo): Token {
  if (!w || typeof w !== "object") {
    throw new Error("missing token (expected { address, symbol, decimals })");
  }
  const address = String(w.address ?? "").toLowerCase();
  if (address !== NATIVE_SENTINEL && !isAddress(address)) {
    throw new Error(`invalid token address: ${w.address}`);
  }
  const decimals = w.decimals;
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    throw new Error(`invalid token decimals for ${address}: ${decimals}`);
  }
  const symbol = String(w.symbol ?? "");
  if (!symbol) throw new Error(`missing token symbol for ${address}`);
  return {
    address,
    symbol,
    name: w.name ?? symbol,
    decimals,
    chainId: chain.chainId,
    source: "wire",
  };
}

// Prefer parseWireQuoteAmounts for quote/build bodies (amountIn XOR amountOut).

/** Shared body fields for quote/stream/build/route amount wiring. */
type AmountWireBody = {
  amountIn?: string;
  amountOut?: string;
  side?: string;
};

/**
 * Resolve fixed amount + trade side from the wire body.
 * Returns core quote args: amountIn is always set for TypeScript (0n placeholder
 * on buy until adapters fully consume amountOut); side + amountOut carry the buy intent.
 *
 * @param opts.allowBothOnBuy — route/build only: accept amountIn+amountOut when
 *   side=buy so a sell-refine venue can re-quote as exact-in at the displayed
 *   pay while keeping the receive target for min-out protection.
 */
function quoteAmountsFromWire(
  b: AmountWireBody,
  opts?: { allowBothOnBuy?: boolean },
): {
  side: TradeSide;
  amountIn: bigint;
  amountOut?: bigint;
} {
  const hasIn = b.amountIn != null && String(b.amountIn).length > 0;
  const hasOut = b.amountOut != null && String(b.amountOut).length > 0;

  if (opts?.allowBothOnBuy && hasIn && hasOut) {
    // Both legs: only valid as buy intent + sell-refine pay seed.
    const sideHint =
      b.side != null && String(b.side).length > 0 ? String(b.side) : "buy";
    if (sideHint === "sell") {
      throw new Error("provide exactly one of amountIn or amountOut");
    }
    if (sideHint !== "buy") {
      throw new Error(`invalid side: ${sideHint} (expected sell|buy)`);
    }
    let amountIn: bigint;
    let amountOut: bigint;
    try {
      amountIn = BigInt(b.amountIn!);
      amountOut = BigInt(b.amountOut!);
    } catch {
      throw new Error("invalid amountIn/amountOut (expected base-units integer)");
    }
    if (amountIn < 0n || amountOut < 0n) {
      throw new Error("amountIn/amountOut must be non-negative");
    }
    return { side: "buy", amountIn, amountOut };
  }

  const parsed = parseWireQuoteAmounts(b);
  if (parsed.side === "sell") {
    return { side: "sell", amountIn: parsed.amountIn!, amountOut: undefined };
  }
  // Buy: fixed leg is amountOut. amountIn is a 0n placeholder for native buy
  // adapters; sell-refine re-quotes pass a positive amountIn via allowBothOnBuy.
  return { side: "buy", amountIn: 0n, amountOut: parsed.amountOut };
}

// Clamp slippage to a sane range; default 10 bps (0.1%), matching the CLI.
function slippageFromWire(slippageBps: number | undefined): number {
  const v = slippageBps ?? 10;
  if (!Number.isFinite(v)) return 10;
  return Math.max(0, Math.min(5000, Math.trunc(v)));
}

// Validate a client-supplied venue name against the dispatcher's venue list
// AND SWAP_DISABLE_VENUES. /api/route and /api/build take the venue verbatim
// (no availableVenues() pass like the quote engine), so without this guard a
// crafted request could still reach a disabled venue — on Vercel that means
// lazy-loading curve and paying its ~12s on-chain init inside a serverless
// function despite SWAP_DISABLE_VENUES=curve.
function venueFromWire(v: string): Venue {
  if (!(VENUES as readonly string[]).includes(v)) {
    throw new Error(`unknown venue: ${v}`);
  }
  if (disabledVenues().has(v as Venue)) {
    throw new Error(`venue '${v}' is disabled on this deployment`);
  }
  return v as Venue;
}

// Exact-out (side="buy") on /api/route + /api/build: a sell-only venue without
// a pay seed (amountIn) is rejected with an explicit 400. When amountIn is
// present, the sell-refine path is allowed: re-quote as exact-in and enforce
// min-out ≥ the receive target at build. The multi-venue quote engine
// seeds sell-only venues itself; single-venue explicit buy without amountIn
// still hard-errors (mirrors CLI `-v kyber --exact-out`).
function buySideError(
  venue: Venue,
  side: TradeSide,
  opts?: { amountIn?: bigint },
): Response | null {
  if (side === "buy" && !isBuyCapable(venue)) {
    if (opts?.amountIn != null && opts.amountIn > 0n) return null;
    return errRes(new UnsupportedSideError(venue).message, 400);
  }
  return null;
}

// Round-trip a value to plain JSON, stringifying any bigint. NormalizedQuote
// may carry bigints in `raw`; this makes it safe to embed in the build
// response's assembleContext (which is echoed back to /assemble verbatim).
function sanitize<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}

// ───────────────────── NormalizedQuote → wire RouteQuote ─────────────────
//
// Single source of truth for the `routes[]` rows of POST /api/quote AND the
// `type:"route"` events of POST /api/quote/stream. The two used to build the
// object inline and had already drifted (the non-stream one dropped
// amountInUsd / amountOutUsd).
//
// The extra fields beyond what the dApp table reads (hops, router,
// protocolFee, tokenHints) exist for non-browser consumers — the CLI's hosted
// mode rebuilds a NormalizedQuote from this row and feeds it to src/format.ts
// / src/json.ts, which need exactly these. Purely additive for the dApp.
//
// `raw` is deliberately NEVER serialized: it is the venue's untouched API
// response (unbounded, venue-specific, and a plausible carrier of bigints).

export type RouteQuoteWire = {
  venue: Venue;
  amountIn: string;
  amountOut: string;
  minAmountOut?: string;
  gasUsd: number | null;
  priceImpactPct: number | null;
  kind: "sync" | "async";
  gasUnits: number | null;
  gasPriceWei: string | null;
  amountInUsd: number | null;
  amountOutUsd: number | null;
  /** Raw hop edges, token ADDRESSES (not symbols — see /api/route for those). */
  hops: NormalizedHop[];
  router: string | null;
  protocolFee: { raw: string; sharePct: number; side: "in" | "out" } | null;
  /** NormalizedQuote.tokenHints as a plain object, keys lowercased. */
  tokenHints: Record<string, TokenHint>;
  buyRefine?: true;
};

function priceImpactPctOf(q: NormalizedQuote): number | null {
  if (q.amountInUsd == null || q.amountOutUsd == null || q.amountInUsd <= 0) {
    return null;
  }
  return ((q.amountOutUsd - q.amountInUsd) / q.amountInUsd) * 100;
}

// Map → object. Keys are lowercased here too: adapters already lowercase by
// convention, but the wire contract states it, so make it true by construction.
function tokenHintsToWire(
  hints: Map<string, TokenHint>,
): Record<string, TokenHint> {
  const out: Record<string, TokenHint> = {};
  for (const [addr, hint] of hints) {
    out[addr.toLowerCase()] = {
      symbol: hint.symbol,
      name: hint.name,
      decimals: hint.decimals,
    };
  }
  return out;
}

export function routeQuoteWire(
  venue: Venue,
  quote: NormalizedQuote,
): RouteQuoteWire {
  return {
    venue,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    ...(quote.minAmountOut ? { minAmountOut: quote.minAmountOut } : {}),
    gasUsd: quote.gasUsd,
    priceImpactPct: priceImpactPctOf(quote),
    kind: (isAsyncVenue(venue) ? "async" : "sync") as "sync" | "async",
    gasUnits: quote.gasUnits,
    gasPriceWei: quote.gasPriceWei,
    amountInUsd: quote.amountInUsd,
    amountOutUsd: quote.amountOutUsd,
    hops: quote.hops,
    router: quote.router,
    protocolFee: quote.protocolFee ?? null,
    tokenHints: tokenHintsToWire(quote.tokenHints),
    ...(quote.buyRefine ? { buyRefine: true as const } : {}),
  };
}

// ───────────────────────────── handlers ─────────────────────────────────

// GET /api/mode — interactive-mode bootstrap. `sid` is "" on Vercel (no
// session gate there); the page reads its own session id from the URL.
export function handleMode(opts?: { sid?: string }): Response {
  // buyVenues: the exact-out (side="buy") capability contract, so the front
  // doesn't hardcode it. Sourced from BUY_CAPABLE_VENUES and filtered by
  // SWAP_DISABLE_VENUES (a deployment shouldn't advertise a disabled venue).
  const disabled = disabledVenues();
  return jsonRes({
    interactive: true,
    // Wire-contract version — a non-browser client (CLI hosted mode) reads it
    // to tell a current deployment from one predating the field it needs.
    apiVersion: API_VERSION,
    sid: opts?.sid ?? "",
    chains: listChains(),
    venues: listVenues(true),
    buyVenues: BUY_CAPABLE_VENUES.filter((v) => !disabled.has(v)),
    defaultChain: "eth",
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID ?? null,
  });
}

// GET /tx — legacy sign-only probe. In interactive mode there is no pre-built
// payload, so we tell the page to render the dApp instead of erroring.
export function handleTxProbe(): Response {
  return jsonRes({ interactive: true });
}

// GET /api/tokens?chain= — curated per-chain token list (ks-setting whitelist).
// Each token's logoURI is rewritten to the server's /api/icon proxy so the
// browser/CDN cache the images (and third-party icon hosts never see the
// visitor). The rewrite is dApp-only — the terminal CLI keeps raw URLs (it
// consumes tokenList() from core.ts directly, not through this handler).
export async function handleTokens(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const chainAlias = url.searchParams.get("chain") ?? "eth";
  try {
    const tokens = await tokenList(chainAlias);
    const alias = resolveChain(chainAlias).alias;
    const rewritten = tokens.map((t) =>
      t.logoURI
        ? { ...t, logoURI: `/api/icon?chain=${alias}&address=${t.address.toLowerCase()}` }
        : t,
    );
    return jsonRes(rewritten);
  } catch (e) {
    console.error(`/api/tokens failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 502);
  }
}

// In-memory icon cache, keyed by upstream logoURI. Same spirit as core.ts's
// tokenListCache: the long-lived local Bun server keeps the picker instant
// after the first open; on Vercel each lambda is ephemeral, so this only
// helps when several icons share an instance. No TTL — token logos effectively
// never change. LRU-capped so a multi-chain session can't grow without bound.
// Images over ICON_STORE_MAX_BYTES are still relayed (with cache-control, so
// the browser/CDN cache them) — they're just not retained in the Map.
const ICON_CACHE_MAX = 512;
const ICON_RELAY_MAX_BYTES = 800 * 1024; // 800 KB
const ICON_STORE_MAX_BYTES = 200 * 1024; // ~200 KB
const iconCache = new Map<string, { bytes: ArrayBuffer; type: string }>();

function iconCacheGet(logoURI: string): { bytes: ArrayBuffer; type: string } | undefined {
  const hit = iconCache.get(logoURI);
  if (!hit) return undefined;
  iconCache.delete(logoURI);
  iconCache.set(logoURI, hit);
  return hit;
}

function iconCacheSet(logoURI: string, value: { bytes: ArrayBuffer; type: string }): void {
  if (iconCache.has(logoURI)) iconCache.delete(logoURI);
  iconCache.set(logoURI, value);
  while (iconCache.size > ICON_CACHE_MAX) {
    const oldest = iconCache.keys().next().value;
    if (oldest === undefined) break;
    iconCache.delete(oldest);
  }
}

// URLs whose scheme we can't fetch (not http/https/ipfs). Tracked so the warn
// fires at most once per distinct URL instead of on every page load.
const unfetchableIconUrls = new Set<string>();

// Rewrite ipfs:// to a public gateway; pass http(s) through unchanged; return
// null for any other scheme (data:, etc.) — the caller 404s so the <img> falls
// back to its initials placeholder.
function fetchableIconUrl(logoURI: string): string | null {
  if (logoURI.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${logoURI.slice("ipfs://".length)}`;
  }
  if (logoURI.startsWith("http://") || logoURI.startsWith("https://")) {
    return logoURI;
  }
  return null;
}

// Browser: 7 days, immutable (logo URL is the token address, logos almost
// never change). CDN: 30 days + SWR so a cold picker doesn't stampede the
// origin. Vercel strips s-maxage from the browser-facing header and honors
// cdn-cache-control / vercel-cdn-cache-control at the edge.
export const ICON_CACHE_CONTROL = "public, max-age=604800, immutable";
export const ICON_CDN_CACHE_CONTROL = "public, max-age=2592000, stale-while-revalidate=86400";

function iconResponse(bytes: ArrayBuffer, type: string): Response {
  return new Response(bytes, {
    headers: {
      "content-type": type,
      "cache-control": ICON_CACHE_CONTROL,
      "cdn-cache-control": ICON_CDN_CACHE_CONTROL,
      "vercel-cdn-cache-control": ICON_CDN_CACHE_CONTROL,
    },
  });
}

// GET /api/icon?chain=<alias>&address=<addr> — token-icon proxy + cache. The
// upstream URL is NEVER taken from the client: we look the token up in the
// curated tokenList and use its logoURI (no open proxy). Guardrails on the
// upstream fetch (image/* content-type, 800 KB relay cap); on any failure or
// bound violation we 302-redirect to the origin so the browser can still try
// it directly. This handler is intentionally exempt from the sid gate in
// serve.ts (it only serves whitelisted token images, loaded via <img> without
// the session id).
export async function handleIcon(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const chainAlias = url.searchParams.get("chain") ?? "";
  const address = (url.searchParams.get("address") ?? "").toLowerCase();
  if (!chainAlias || (address !== NATIVE_SENTINEL && !isAddress(address))) {
    return errRes("missing/invalid 'chain' or 'address'", 400);
  }

  let logoURI: string;
  try {
    const tokens = await tokenList(chainAlias); // validates chain, cached 10 min
    const logo = tokens.find((t) => t.address.toLowerCase() === address)?.logoURI;
    if (!logo) return errRes("token/icon not found", 404);
    logoURI = logo;
  } catch (e) {
    console.error(`/api/icon lookup failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 400);
  }

  const cached = iconCacheGet(logoURI);
  if (cached) return iconResponse(cached.bytes, cached.type);

  // Resolve to a fetchable URL (ipfs:// → gateway). Unfetchable schemes can't
  // be served by a 302 either (the browser can't load data:/ipfs: from <img
  // src> reliably), so 404 and let the <img> fall back to its initials.
  const fetchURL = fetchableIconUrl(logoURI);
  if (!fetchURL) {
    if (!unfetchableIconUrls.has(logoURI)) {
      unfetchableIconUrls.add(logoURI);
      console.warn(`/api/icon unfetchable scheme for ${logoURI}`);
    }
    return errRes("icon not fetchable", 404);
  }

  // Fall back to a client-side direct load if the upstream fetch fails or the
  // response violates our bounds — never fail the icon outright.
  const redirect = () => Response.redirect(fetchURL, 302);
  try {
    const res = await fetch(fetchURL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`/api/icon upstream ${res.status} for ${fetchURL}`);
      return redirect();
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      console.warn(`/api/icon non-image content-type '${type}' for ${fetchURL}`);
      return redirect();
    }
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > ICON_RELAY_MAX_BYTES) {
      console.warn(`/api/icon oversize (${len} bytes) for ${fetchURL}`);
      return redirect();
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > ICON_RELAY_MAX_BYTES) {
      console.warn(`/api/icon oversize (${bytes.byteLength} bytes read) for ${fetchURL}`);
      return redirect();
    }
    // Relay always (with cache-control); retain in the memory Map when small
    // enough — larger images are cached downstream by the browser/CDN.
    if (bytes.byteLength <= ICON_STORE_MAX_BYTES) {
      iconCacheSet(logoURI, { bytes, type });
    }
    return iconResponse(bytes, type);
  } catch (e) {
    console.warn(`/api/icon fetch failed for ${fetchURL}: ${(e as Error).message}`);
    return redirect();
  }
}

// POST /api/resolve-token { chain, input } — paste any 0x address or symbol.
export async function handleResolveToken(req: Request): Promise<Response> {
  try {
    const b = (await req.json()) as { chain?: string; input?: string };
    if (!b.input) return errRes("missing 'input'");
    const t = await resolveOneToken({ chainAlias: b.chain ?? "eth", input: b.input });
    return jsonRes({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals });
  } catch (e) {
    console.error(`/api/resolve-token failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 404);
  }
}

// POST /api/quote — the `-v all` engine. Returns ranked routes; no wallet
// needed. quoteId is a client-side grouping key (no server cache backs it).
// Wire: exactly one of amountIn | amountOut (base-units string); optional side.
export async function handleQuote(req: Request): Promise<Response> {
  try {
    const b = (await req.json()) as {
      chain?: string;
      tokenInAddress?: string;
      tokenOutAddress?: string;
      amountIn?: string; // base units — sell
      amountOut?: string; // base units — buy (exact-out)
      side?: string;
      slippageBps?: number;
      allowAsync?: boolean;
      venues?: Venue[];
      /** CLI --disableodosrfq / dApp Advanced: odos/odosv2 send disableRFQs:true. */
      disableOdosRfq?: boolean;
    };
    if (!b.tokenInAddress || !b.tokenOutAddress) {
      return errRes("missing tokenInAddress / tokenOutAddress");
    }
    let side: TradeSide;
    let amountIn: bigint;
    let amountOut: bigint | undefined;
    try {
      ({ side, amountIn, amountOut } = quoteAmountsFromWire(b));
    } catch (e) {
      return errRes((e as Error).message, 400);
    }

    const { chain, tokenIn, tokenOut } = await resolveTokenPair({
      chainAlias: b.chain ?? "eth",
      tokenInInput: b.tokenInAddress,
      tokenOutInput: b.tokenOutAddress,
    });
    const slippageBps = slippageFromWire(b.slippageBps);

    const { best, results } = await quoteAll({
      chain,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      side,
      slippageBps,
      allowAsync: b.allowAsync ?? false,
      venues: b.venues,
      disableOdosRfq: b.disableOdosRfq === true,
    });
    if (!best) {
      const firstErr = results.find((r) => "error" in r) as { error: string } | undefined;
      return errRes(firstErr?.error ?? "no venue returned a quote", 502);
    }

    const quoteId = randomBytes(8).toString("hex");
    const amountInUsd = best.quote.amountInUsd;
    const amountOutUsd = best.quote.amountOutUsd;

    const routes = sortRoutesBySide(
      results
        .filter((r): r is { venue: Venue; quote: NormalizedQuote } => "quote" in r)
        .map((r) => {
          const row = routeQuoteWire(r.venue, r.quote);
          // `execution` is the ranking input only — stripped right after the
          // sort so it never reaches the wire.
          return {
            ...row,
            execution: toExecution(row.kind, row.gasUnits, row.gasPriceWei),
          };
        }),
      side,
      GROSS,
    ).map(({ execution: _execution, ...row }) => row);

    const respAmountIn = best.quote.amountIn;
    const respAmountOut = best.quote.amountOut;
    const humanIn = fromBaseUnits(respAmountIn, tokenIn.decimals, 8);
    const humanOut = fromBaseUnits(respAmountOut, tokenOut.decimals, 8);
    const rate =
      Number(humanIn) > 0
        ? `1 ${tokenIn.symbol} = ${(Number(humanOut) / Number(humanIn)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${tokenOut.symbol}`
        : "";

    return jsonRes({
      quoteId,
      side,
      chain: { chainId: chain.chainId, name: chain.displayName, explorer: chain.explorer, nativeSymbol: chain.nativeSymbol },
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      amountIn: respAmountIn,
      amountOut: respAmountOut,
      best: {
        venue: best.venue,
        amountIn: best.quote.amountIn,
        amountOut: best.quote.amountOut,
      },
      routes,
      tokenInUsd: perUnitUsd(amountInUsd, respAmountIn, tokenIn.decimals),
      tokenOutUsd: perUnitUsd(amountOutUsd, respAmountOut, tokenOut.decimals),
      rate,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    });
  } catch (e) {
    console.error(`/api/quote failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 502);
  }
}

// POST /api/quote/stream — NDJSON stream; one route per line as each venue
// settles. Stateless: the quoteId is emitted in the meta line as a client key.
export async function handleQuoteStream(req: Request): Promise<Response> {
  let b: {
    chain?: string;
    tokenInAddress?: string;
    tokenOutAddress?: string;
    amountIn?: string;
    amountOut?: string;
    side?: string;
    slippageBps?: number;
    allowAsync?: boolean;
    venues?: Venue[];
    /** CLI --disableodosrfq / dApp Advanced: odos/odosv2 send disableRFQs:true. */
    disableOdosRfq?: boolean;
  };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return errRes("bad json");
  }
  if (!b.tokenInAddress || !b.tokenOutAddress) {
    return errRes("missing tokenInAddress / tokenOutAddress");
  }

  let side: TradeSide;
  let amountIn: bigint;
  let amountOut: bigint | undefined;
  try {
    ({ side, amountIn, amountOut } = quoteAmountsFromWire(b));
  } catch (e) {
    return errRes((e as Error).message, 400);
  }

  let chain: ChainInfo, tokenIn: Token, tokenOut: Token;
  try {
    ({ chain, tokenIn, tokenOut } = await resolveTokenPair({
      chainAlias: b.chain ?? "eth",
      tokenInInput: b.tokenInAddress,
      tokenOutInput: b.tokenOutAddress,
    }));
  } catch (e) {
    console.error(`/api/quote/stream resolve failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 502);
  }
  const slippageBps = slippageFromWire(b.slippageBps);
  const allowAsync = b.allowAsync ?? false;
  const venuesFilter = b.venues;
  const disableOdosRfq = b.disableOdosRfq === true;
  const quoteId = randomBytes(8).toString("hex");

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      send({
        type: "meta",
        quoteId,
        side,
        chain: { chainId: chain.chainId, name: chain.displayName, explorer: chain.explorer, nativeSymbol: chain.nativeSymbol },
        tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
        tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
        // Fixed leg on the wire; for buy, amountIn is filled as routes arrive.
        amountIn: side === "sell" ? amountIn.toString() : undefined,
        amountOut: side === "buy" ? amountOut!.toString() : undefined,
        expiresAt: Date.now() + QUOTE_TTL_MS,
      });
      try {
        for await (const r of quoteAllStream({
          chain, tokenIn, tokenOut, amountIn, amountOut, side, slippageBps, allowAsync, venues: venuesFilter,
          disableOdosRfq,
        })) {
          if ("quote" in r) {
            send({ type: "route", route: routeQuoteWire(r.venue, r.quote) });
          } else {
            send({ type: "verror", venue: r.venue, error: r.error });
          }
        }
        send({ type: "done", expiresAt: Date.now() + QUOTE_TTL_MS });
      } catch (e) {
        console.error(`/api/quote/stream fatal: ${(e as Error).message}`);
        send({ type: "fatal", error: (e as Error).message });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

// POST /api/route — symbol-labelled hop edges for the chosen venue's route
// graph. STATELESS contract: the front-end re-sends the pair + amount (it
// already has them), so we re-quote the single venue and resolve its hops.
// No quoteId is needed — the route graph is derived fresh.
export async function handleRoute(req: Request): Promise<Response> {
  try {
    const b = (await req.json()) as {
      chain?: string;
      venue?: string;
      amountIn?: string;
      amountOut?: string;
      side?: string;
      slippageBps?: number;
      tokenIn?: WireToken;
      tokenOut?: WireToken;
      /** CLI --disableodosrfq / dApp Advanced: odos/odosv2 send disableRFQs:true. */
      disableOdosRfq?: boolean;
    };
    if (!b.chain || !b.venue) return errRes("missing 'chain' or 'venue'");
    const chain = resolveChain(b.chain);
    const tokenIn = tokenFromWire(b.tokenIn, chain);
    const tokenOut = tokenFromWire(b.tokenOut, chain);
    let side: TradeSide;
    let amountIn: bigint;
    let amountOut: bigint | undefined;
    try {
      ({ side, amountIn, amountOut } = quoteAmountsFromWire(b, { allowBothOnBuy: true }));
    } catch (e) {
      return errRes((e as Error).message, 400);
    }
    const slippageBps = slippageFromWire(b.slippageBps);
    const venue = venueFromWire(b.venue);
    const buyErr = buySideError(venue, side, { amountIn });
    if (buyErr) return buyErr;

    // Sell-refine: re-quote as exact-in at the pay seed; native buy stays buy.
    const sellRefine = side === "buy" && !isBuyCapable(venue);
    if (sellRefine && (amountIn <= 0n || amountOut == null)) {
      return errRes(
        "sell-only venue on exact-out requires amountIn (pay seed) and amountOut (target)",
        400,
      );
    }
    const quote = await quoteSingle({
      chain,
      tokenIn,
      tokenOut,
      amountIn: sellRefine ? amountIn : amountIn,
      amountOut: sellRefine ? undefined : amountOut,
      side: sellRefine ? "sell" : side,
      slippageBps,
      venue,
      disableOdosRfq: b.disableOdosRfq === true,
    });
    if (sellRefine && amountOut != null && BigInt(quote.amountOut) < amountOut) {
      return errRes(
        `sell refine below exact-out target (${quote.amountOut} < ${amountOut})`,
        502,
      );
    }
    const hops = await resolveRouteHops({ chain, tokenIn, tokenOut, quote });
    return jsonRes({
      venue: b.venue,
      side,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      hops,
    });
  } catch (e) {
    console.error(`/api/route failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 502);
  }
}

// POST /api/build — chosen venue → Payload the existing SendTx / SignOrder /
// SignPermitTx components consume unchanged. STATELESS contract: the body
// carries the pair + amount + venue, so the chosen venue is re-quoted fresh
// (Odos pathIds / Velora priceRoutes go stale within ~30s) and built.
//
// `opts.sid` only feeds rewriteAuthedOrderSubmit's local session gate; on
// Vercel it is absent and the submit URL carries no id (handleSubmit there is
// gateless, reconstructing the relayer target from the URL params instead).
export async function handleBuild(req: Request, opts?: { sid?: string }): Promise<Response> {
  const sid = opts?.sid ?? "";
  try {
    const b = (await req.json()) as {
      venue?: string;
      sender?: string;
      recipient?: string | null;
      slippageBps?: number;
      chain?: string;
      tokenIn?: WireToken;
      tokenOut?: WireToken;
      amountIn?: string;
      amountOut?: string;
      side?: string;
      /** CLI --odosnotcompact: force compact:false on odosv2 build re-quote. */
      odosNotCompact?: boolean;
      /** CLI --disableodosrfq / dApp Advanced: odos/odosv2 send disableRFQs:true. */
      disableOdosRfq?: boolean;
    };
    if (!b.venue || !b.sender) return errRes("missing 'venue' or 'sender'");
    if (!b.chain) return errRes("missing 'chain'");
    if (!isAddress(b.sender)) return errRes(`invalid sender address: ${b.sender}`);
    if (b.recipient != null && !isAddress(b.recipient)) {
      return errRes(`invalid recipient address: ${b.recipient}`);
    }
    // Velora (and others) reject non-EIP-55 senders; the sender is embedded as
    // the swap output recipient, so normalize it the way the CLI does.
    const sender = toChecksumAddress(b.sender);

    const chain = resolveChain(b.chain);
    const tokenIn = tokenFromWire(b.tokenIn, chain);
    const tokenOut = tokenFromWire(b.tokenOut, chain);
    let side: TradeSide;
    let amountIn: bigint;
    let amountOutFixed: bigint | undefined;
    try {
      ({ side, amountIn, amountOut: amountOutFixed } = quoteAmountsFromWire(b, {
        allowBothOnBuy: true,
      }));
    } catch (e) {
      return errRes((e as Error).message, 400);
    }
    const slippageBps = slippageFromWire(b.slippageBps);
    const odosNotCompact = b.odosNotCompact === true;
    const disableOdosRfq = b.disableOdosRfq === true;

    // wrap/unwrap & send short-circuit the venue loop — no quote needed.
    // Exact-out is meaningless for wrap/send; require sell amountIn.
    const isShortCircuit = b.venue === "wrap" || b.venue === "send";
    if (isShortCircuit && side === "buy") {
      return errRes("wrap/send do not support amountOut (exact-out)", 400);
    }
    // Sell-only venue on exact-out without pay seed → 400; with amountIn → refine.
    if (!isShortCircuit) {
      const buyErr = buySideError(venueFromWire(b.venue), side, { amountIn });
      if (buyErr) return buyErr;
    }

    const venue = isShortCircuit ? (b.venue as Venue) : venueFromWire(b.venue);
    const sellRefine =
      !isShortCircuit && side === "buy" && !isBuyCapable(venue);
    if (sellRefine && (amountIn <= 0n || amountOutFixed == null)) {
      return errRes(
        "sell-only venue on exact-out requires amountIn (pay seed) and amountOut (target)",
        400,
      );
    }

    const quote: NormalizedQuote = isShortCircuit
      ? ({} as NormalizedQuote)
      : await quoteSingle({
          chain,
          tokenIn,
          tokenOut,
          amountIn: sellRefine ? amountIn : amountIn,
          amountOut: sellRefine ? undefined : amountOutFixed,
          side: sellRefine ? "sell" : side,
          slippageBps,
          venue,
          disableOdosRfq,
        });

    if (sellRefine && amountOutFixed != null) {
      const guaranteedOut = quote.minAmountOut ?? quote.amountOut;
      if (BigInt(guaranteedOut) < amountOutFixed) {
        return errRes(
          `sell refine below exact-out target (${guaranteedOut} < ${amountOutFixed})`,
          502,
        );
      }
      // Tag so build() rewrites to sell + min-out floor at the receive target.
      quote.buyRefine = {
        targetAmountOut: amountOutFixed.toString(),
        seedAmountIn: amountIn.toString(),
      };
    }

    // The buy quote's estimated input (what you'd pay at the quoted price). Used
    // as the build param + the base for the approval ceiling below.
    const buyEstIn =
      side === "buy" && !isShortCircuit && quote.amountIn && BigInt(quote.amountIn) > 0n
        ? BigInt(quote.amountIn)
        : amountIn;

    // Approval: native exact-out authorises maxAmountIn (estimate + slip);
    // sell-refine is exact-in at the seed pay — approve the exact amountIn only.
    // sell (default) keeps the exact fixed input.
    const allowanceAmount = isShortCircuit
      ? amountIn
      : sellRefine
        ? buyEstIn
        : side === "buy"
          ? maxAmountIn(buyEstIn, slippageBps)
          : amountIn;

    const result: BuildResult = await buildForVenue({
      chain, tokenIn, tokenOut, amountIn: isShortCircuit ? amountIn : buyEstIn,
      // Thread the fixed leg + side so the dispatcher builds the right
      // direction. Without them, adapters that read params.side (velora/matcha)
      // fall back to sell and emit an exact-in tx for an exact-out intent.
      // Sell-refine: amountOut stays on the quote via buyRefine; build() forces sell.
      amountOut: side === "buy" && !sellRefine ? amountOutFixed : undefined,
      side: sellRefine ? "sell" : side,
      sender,
      slippageBps,
      quote,
      venue: b.venue,
      recipient: b.recipient ?? null,
      odosNotCompact,
      disableOdosRfq,
    });

    // Allowance — applies to sync tx AND async order (orders pull the sell
    // token via the protocol's relayer). Skipped for native / wrap / send,
    // and for a build that pays its ERC20 input through msg.value (Arc's
    // native USDC): `approval = null` is the shape the page already handles
    // for native input, so no extra approve step is surfaced.
    let approval: ApprovalForBrowser | null = null;
    if (
      needsAllowanceCheck(tokenIn, b.venue, chain) &&
      !inputPaidViaValue(chain, tokenIn.address, result)
    ) {
      const a = await checkAllowance({
        chain,
        tokenIn,
        amountIn: allowanceAmount,
        sender,
        spender: result.spender,
      });
      approval = {
        needed: !a.sufficient,
        current: a.current.toString(),
        required: a.needed.toString(),
        approveTx: a.approveTx ? withFromFallback(a.approveTx, sender) : null,
      };
    }

    const respAmountIn = isShortCircuit ? amountIn.toString() : quote.amountIn;
    const amountOut = isShortCircuit ? amountIn.toString() : quote.amountOut;

    const payload: Payload = {
      kind: result.kind,
      venue: b.venue,
      chain: { chainId: chain.chainId, name: chain.displayName, explorer: chain.explorer, nativeSymbol: chain.nativeSymbol },
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      amountIn: respAmountIn,
      amountOut,
      ...(quote.minAmountOut ? { minAmountOut: quote.minAmountOut } : {}),
      sender,
      recipient: b.recipient ?? null,
      slippageBps,
      simulateEnabled: false,
      approval,
      tx: result.kind === "tx" ? withFromFallback(stripKind(result), sender) : null,
      order: result.kind === "order" ? rewriteAuthedOrderSubmit(result, sid) : null,
      permitTx: result.kind === "permit-tx" ? result : null,
      // For the stateless permit-tx leg, the build response carries the
      // context /assemble needs (no in-process pendingPermit). bigints in the
      // quote's `raw` are stringified so it survives the JSON round-trip.
      assembleContext:
        result.kind === "permit-tx"
          ? sanitize({ venue: b.venue, chain: chain.alias, sender, quote })
          : undefined,
      walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID ?? null,
    };

    return jsonRes(payload);
  } catch (e) {
    console.error(`/api/build failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 502);
  }
}

// POST /assemble — permit-tx second leg, STATELESS. The body carries the
// signature AND the opaque context the build step handed back (no server-side
// pendingPermit). We resolve the chain alias, then call coreAssemble with the
// context's venue / sender / quote.
export async function handleAssemble(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      signature?: string;
      context?: { venue?: string; chain?: string; sender?: string; quote?: unknown };
    };
    if (!body.signature) return errRes("missing 'signature'");
    const ctx = body.context;
    if (!ctx || !ctx.venue || !ctx.chain || !ctx.sender || ctx.quote == null) {
      return errRes("missing assemble context — rebuild the swap", 400);
    }
    if (!isAddress(ctx.sender)) return errRes(`invalid sender address: ${ctx.sender}`);
    const chain = resolveChain(ctx.chain);
    const tx = await coreAssemble({
      venue: ctx.venue as Venue,
      chain,
      sender: ctx.sender,
      signature: body.signature,
      quote: ctx.quote as NormalizedQuote,
    });
    return jsonRes({ tx: withFromFallback(tx, ctx.sender) });
  } catch (e) {
    console.error(`/assemble failed: ${(e as Error).message}`);
    return errRes((e as Error).message, 502);
  }
}

// POST /submit — authed-order submission leg, STATELESS. The relayer URL is
// built ENTIRELY server-side from the (venue, chainId) query params that
// rewriteAuthedOrderSubmit put there — NEVER from a client-supplied URL, which
// would turn this into an open proxy for the API key. Only venues that need
// a server-held secret (fusion Bearer, uniswapx x-api-key) are supported.
export async function handleSubmit(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const venue = url.searchParams.get("venue");
  const chainIdRaw = url.searchParams.get("chainId");
  const orderHash = url.searchParams.get("orderHash") ?? "";

  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return errRes(`/submit: invalid chainId ${chainIdRaw ?? "(none)"}`, 400);
  }

  // Server-constructed relayer URL + auth — the client only chooses venue/chainId.
  let relayerUrl: string;
  let auth: { kind: "bearer" | "api-key"; envVar: string };
  if (venue === "fusion") {
    relayerUrl = `https://api.1inch.dev/fusion/relayer/v2.0/${chainId}/order/submit`;
    auth = { kind: "bearer", envVar: "ONEINCH_API_KEY" };
  } else if (venue === "uniswapx") {
    relayerUrl = "https://trade-api.gateway.uniswap.org/v1/order";
    auth = { kind: "api-key", envVar: "UNISWAP_API_KEY" };
  } else {
    return errRes(
      `/submit: unsupported venue ${venue ?? "(none)"} — only fusion and uniswapx are proxied`,
      400,
    );
  }

  const order: NormalizedOrder = {
    kind: "order",
    venue: venue as "fusion" | "uniswapx",
    spender: "",
    signer: "",
    typedData: { domain: {}, types: {}, primaryType: "", message: {} },
    submit: {
      url: relayerUrl,
      method: "POST",
      bodyTemplate: {},
      auth,
    },
    orderHash: orderHash || undefined,
    validUntilSec: 0,
    decayStartSec: null,
    chainId,
  };
  return proxyOrderSubmit(order, await req.text());
}

// POST /simulate — simulation isn't surfaced in the v1 dApp; report skipped so
// the page never hangs waiting on it.
export function handleSimulate(): Response {
  return jsonRes({ kind: "skipped", reason: "simulation is not enabled in the interactive dApp" });
}

// POST /done — terminal callback. The session has no state to clear; we emit
// one structured `evt:done` line on stdout plus the human-readable line on
// stderr (the local serve.ts keeps running; on Vercel each call is independent).
export async function handleDone(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    console.error(`/done parse failed: ${(e as Error).message}`);
    return new Response("bad json", { status: 400 });
  }
  const parsed = parseDoneReport(raw);
  if (!parsed.ok) {
    console.error(`/done parse failed: ${parsed.reason}`);
    return new Response("bad json", { status: 400 });
  }
  const report = parsed.report;
  console.log(doneEventLine(report));
  if (process.env.VERCEL) return new Response("ok");
  if (report.kind === "error") console.error(`  ✗ swap error: ${report.error}`);
  else if (report.kind === "tx") console.error(`  ✓ tx ${report.hash}`);
  else console.error(`  ✓ order ${report.orderId}`);
  return new Response("ok");
}

// build() returns `{kind:"tx"} & NormalizedTx`; the Payload wants the bare
// NormalizedTx. Strip the discriminator.
function stripKind(r: BuildResult & { kind: "tx" }) {
  const { kind: _k, ...tx } = r;
  return tx;
}

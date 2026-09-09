// dApp wire types + component prop interfaces.
//
// These mirror the /api contract the backend track is building (see the project
// brief). The Components and Assembly phases implement/consume exactly these
// shapes, so this file is the single source of truth for the interactive dApp's
// data model. Wire shapes here MUST stay in lockstep with the backend's JSON.

import type React from "react";
import type { Payload } from "../payload";

/* ------------------------------------------------------------------ *
 * GET /api/mode
 * ------------------------------------------------------------------ */

// One supported chain, as surfaced by /api/mode. `alias` is the CLI's short
// name (eth/arb/base/…) and is what /api/tokens, /api/quote, etc. take as the
// `chain` parameter.
export type ChainMeta = {
  alias: string;
  chainId: number;
  name: string;
  explorer: string;
  nativeSymbol: string;
  wrappedNative: string;
};

// One venue the backend can route through. `kind` distinguishes sync (broadcast
// a tx) from async (sign an intent + POST) — async venues only participate when
// allowAsync is on.
export type VenueMeta = {
  name: string;
  kind: "sync" | "async";
};

// GET /api/mode response. `interactive:true` selects the dApp; the legacy
// sign-only --browser flow does not hit this endpoint (App.tsx falls back).
export type ApiMode = {
  interactive: true;
  sid: string;
  chains: ChainMeta[];
  venues: VenueMeta[];
  /**
   * Venues with native exact-out (side=buy). Sell-only venues can still appear
   * on buy via the server's sell-refine pass (`RouteQuote.buyRefine`); this
   * list stays the native-capability contract (`/api/mode` `buyVenues`).
   */
  buyVenues?: string[];
  defaultChain: string;
  walletConnectProjectId: string | null;
};

/* ------------------------------------------------------------------ *
 * GET /api/tokens  ·  POST /api/resolve-token
 * ------------------------------------------------------------------ */

// A token in a chain's curated list (GET /api/tokens) or the result of
// POST /api/resolve-token. `logoURI` is present only in the curated list.
export type TokenInfo = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
};

/* ------------------------------------------------------------------ *
 * POST /api/quote
 * ------------------------------------------------------------------ */

// One ranked venue quote inside a QuoteResponse.routes[]. amountIn/amountOut
// are base-units decimal strings. gasUsd / priceImpactPct may be null when the
// venue's API doesn't supply them.
export type RouteQuote = {
  venue: string;
  amountIn: string;
  amountOut: string;
  gasUsd: number | null;
  priceImpactPct: number | null;
  kind: "sync" | "async";
  gasUnits: number | null;
  gasPriceWei: string | null;
  // True when this route was produced client-side (by the in-browser curve
  // integration) rather than by the server's /api/quote stream. The build /
  // route-graph paths branch on this: a clientSide route builds via
  // buildCurve() locally and synthesizes its own RouteGraphResponse, never
  // hitting /api/build or /api/route.
  clientSide?: boolean;
  /**
   * Exact-out sell-refine: venue was quoted as exact-in at the best native-buy
   * pay seed and met the receive target. Build/route must re-send amountIn +
   * amountOut (side=buy) so the server re-quotes as sell with min-out floor.
   */
  buyRefine?: boolean;
};

// POST /api/quote response. routes[] is already ranked best-first; `best`
// echoes routes[0]. A quote needs no wallet. `expiresAt` is an epoch ms after
// which the quote should be refreshed.
export type TradeSide = "sell" | "buy";

export type QuoteResponse = {
  quoteId: string;
  /** Request side: sell = exact-in, buy = exact-out. */
  side: TradeSide;
  chain: {
    chainId: number;
    name: string;
    explorer: string;
    nativeSymbol: string;
  };
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  /** Always filled after a successful quote (both sides). */
  amountIn: string;
  amountOut: string;
  best: { venue: string; amountIn: string; amountOut: string };
  routes: RouteQuote[];
  // Venues that were queried but couldn't quote this pair (errored). Surfaced
  // muted in the routes pane so e.g. intent venues rejecting native-ETH input
  // are visibly explained rather than silently dropped. Streaming-only.
  unavailable?: { venue: string; reason: string }[];
  tokenInUsd: number | null;
  tokenOutUsd: number | null;
  rate: string;
  expiresAt: number;
};

/* ------------------------------------------------------------------ *
 * POST /api/quote/stream  (NDJSON — one event per line)
 * ------------------------------------------------------------------ */

// A streamed route carries the venue's whole-amount USD too, so the client can
// derive live per-unit USD + rate from the best-so-far without waiting for the
// final aggregate.
export type RawRoute = RouteQuote & {
  amountInUsd: number | null;
  amountOutUsd: number | null;
};

export type QuoteStreamEvent =
  | {
      type: "meta";
      quoteId: string;
      side: TradeSide;
      chain: QuoteResponse["chain"];
      tokenIn: QuoteResponse["tokenIn"];
      tokenOut: QuoteResponse["tokenOut"];
      /** Present on sell (exact-in). */
      amountIn?: string;
      /** Present on buy (exact-out). */
      amountOut?: string;
      expiresAt: number;
    }
  | { type: "route"; route: RawRoute }
  | { type: "verror"; venue: string; error: string }
  | { type: "done"; expiresAt: number }
  | { type: "fatal"; error: string };

/* ------------------------------------------------------------------ *
 * POST /api/route  →  symbol-labelled hop edges for the graphical route view
 * ------------------------------------------------------------------ */

// One edge of the route graph: tokenIn symbol → tokenOut symbol through a
// protocol/pool, carrying the tokenIn base-units routed through it (for
// proportional ribbon widths).
export type RouteHop = {
  from: string;
  to: string;
  exchange: string;
  swapAmount: string;
  // swapAmount is only a split weight denominated in the route input token
  // (openocean / 1inch downstream hops) — never display it as an amount.
  approxAmount?: boolean;
  // Hop output in tokenOut base units — only when the venue reports it.
  amountOut?: string;
  fromName: string;
  fromDecimals: number;
  toDecimals: number;
};

export type RouteGraphResponse = {
  venue: string;
  tokenIn: string;
  tokenOut: string;
  hops: RouteHop[];
};

/* ------------------------------------------------------------------ *
 * POST /api/quote request body
 * ------------------------------------------------------------------ */

export type QuoteRequest = {
  chain: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  /** Exactly one of amountIn / amountOut (base-units string). */
  amountIn?: string;
  amountOut?: string;
  /** Optional; must match which amount field is present when set. */
  side?: TradeSide;
  slippageBps: number;
  allowAsync: boolean;
  venues?: string[];
  /** CLI --disableodosrfq / Settings → Advanced: odos/odosv2 disableRFQs. */
  disableOdosRfq?: boolean;
};

/* ------------------------------------------------------------------ *
 * POST /api/build  →  BuildPayload (identical to web/src/payload.ts Payload)
 * ------------------------------------------------------------------ */

// /api/build returns an object identical in shape to the existing Payload, so
// it can be fed straight into <SendTx>/<SignOrder>/<SignPermitTx> unchanged.
export type BuildPayload = Payload;

// Wire shape for a token carried inside /api/build and /api/route requests.
// The server reconstructs a Token object from these fields without making
// any network calls — no symbol resolution at build/route time.
export type WireTokenInfo = {
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
};

export type BuildRequest = {
  venue: string;
  sender: string;
  recipient?: string | null;
  slippageBps?: number;
  // Full context: the server rebuilds the quote fresh from these fields.
  // No quoteId — the stateless handler never reads a server-side cache.
  chain: string;
  tokenIn: WireTokenInfo;
  tokenOut: WireTokenInfo;
  /**
   * amountIn XOR amountOut for native paths. Sell-refine on buy may send both
   * (amountOut = receive target, amountIn = pay seed) with side=buy.
   */
  amountIn?: string;
  amountOut?: string;
  side?: TradeSide;
  /** CLI --odosnotcompact: force compact:false on odosv2 build re-quote. */
  odosNotCompact?: boolean;
  /** CLI --disableodosrfq / Settings → Advanced: odos/odosv2 disableRFQs. */
  disableOdosRfq?: boolean;
};

/* ------------------------------------------------------------------ *
 * POST /api/route request body (stateless — no quoteId)
 * ------------------------------------------------------------------ */

export type RouteRequest = {
  chain: string;
  venue: string;
  /** Same amount contract as BuildRequest (XOR, or both on buy refine). */
  amountIn?: string;
  amountOut?: string;
  side?: TradeSide;
  slippageBps?: number;
  tokenIn: WireTokenInfo;
  tokenOut: WireTokenInfo;
  /** CLI --disableodosrfq / Settings → Advanced: odos/odosv2 disableRFQs. */
  disableOdosRfq?: boolean;
};

/* ------------------------------------------------------------------ *
 * Component prop interfaces (implemented in the Components/Assembly phases)
 * ------------------------------------------------------------------ */

// <TokenSelector> — modal token picker for one side of the pair.
export interface TokenSelectorProps {
  chain: ChainMeta;
  value: TokenInfo | null;
  onSelect: (token: TokenInfo) => void;
  onClose: () => void;
  open: boolean;
}

// <RoutesPane> — the right-hand ranked-venue panel. `action` is the freeform
// node rendered for the no-routing modes (wrap/unwrap/send) or a header slot;
// click a row to select a venue for execution.
export interface RoutesPaneProps {
  quote: QuoteResponse | null;
  selectedVenue: string | null;
  onSelect: (venue: string) => void;
  action: React.ReactNode;
  // Re-quote control surfaced as a refresh button in the pane header.
  onRefresh?: () => void;
  // First 3s of a new countdown. Streaming does not lock clicks.
  refreshLocked?: boolean;
  // True from stream start until ALL venues have settled. Spins the refresh icon
  // (until every quote is in), keeps the button visible mid-stream, and shows
  // the "Comparing venues…" hint while no routes are in yet. Also locks the
  // list min-height so a progressive re-stream doesn't collapse the pane.
  streaming?: boolean;
  // Seconds until the displayed quote auto-refreshes. Drives the header
  // countdown label and the progress ring around the refresh button.
  secondsToExpiry?: number | null;
  // The "Include intent venues" toggle, surfaced as a pill in the pane header
  // (it directly governs which venues appear in this list).
  allowAsync: boolean;
  onAllowAsync: (allow: boolean) => void;
}

// <SettingsPopover> — venue filters + Copy CLI extras (--json / -d / --simu)
// + custom-token manager (all chains). (Slippage lives on the swap card's
// "Max slippage" row; the intent/async toggle lives in the RoutesPane header.)
export interface SettingsPopoverProps {
  venues: VenueMeta[];
  enabledVenues: string[];
  onToggleVenue: (venue: string) => void;
  // Enable (true) or disable (false) every venue at once.
  onSetAllVenues: (on: boolean) => void;
  // Read-only mirror of the RoutesPane "Intent" toggle. When false, intent
  // (async) venues are globally gated off — their rows render disabled/off and
  // are excluded from the "N/M on" count, so the list never shows an intent
  // venue as active while Intent is turned off.
  allowAsync: boolean;
  // Copy-CLI extras: extra flags appended when copying the equivalent `swap …`
  // command. Persisted in localStorage (`swap.cliCopyFlags.v1`).
  cliJson: boolean;
  onCliJson: (v: boolean) => void;
  cliData: boolean;
  onCliData: (v: boolean) => void;
  cliSimu: boolean;
  onCliSimu: (v: boolean) => void;
  // Scopes the custom-token management list (stored per chainId).
  chain: ChainMeta;
}

// <Header> — brand + chain selector. Connect button is rendered separately via
// RainbowKit's ConnectButton.Custom inside the header by the Assembly phase.
export interface HeaderProps {
  chains: ChainMeta[];
  chain: ChainMeta;
  onChain: (chain: ChainMeta) => void;
}

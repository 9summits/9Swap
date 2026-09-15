// Hosted mode — consume the stateless `/api/*` contract instead of the local
// venue engine.
//
// In hosted mode the CLI holds no venue API keys and makes no RPC call for the
// quote/build path: `/api/quote/stream` replaces `fetchAllQuotesStream`,
// `/api/build` replaces `build()` (allowance included), `/api/resolve-token`
// replaces `resolveToken`. The CLI never signs anything — it renders the same
// `NormalizedQuote` / `NormalizedTx` / `NormalizedOrder` / `NormalizedPermitTx`
// shapes the local engine produces, so `format.ts` / `json.ts` stay untouched.
//
// Non-negotiables mirrored from the local path:
//   - decimals come from the server and are validated, never defaulted to 18
//     (see docs/conventions.md — decimals are safety-critical);
//   - no silent fallback to the local engine when the hosted API is down. That
//     is the same reasoning as the no-public-RPC-fallback rule: silently
//     swapping the execution backend under the user is worse than failing with
//     the exact flag to pass (`--local`).
import pkg from "../package.json";
import type { ChainInfo } from "./chains.ts";
import { API_VERSION } from "./server/shared.ts";
import type { ApprovalForBrowser, Payload } from "./server/shared.ts";
import type { Token } from "./tokens.ts";
import type { TradeSide } from "./trade_side.ts";
import { VENUES } from "./venues/index.ts";
import type {
  BuildResult,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  TokenHint,
  Venue,
  VenueResult,
} from "./venues/index.ts";

/** Public deployment the `--hosted` flag points at. */
export const HOSTED_DEFAULT = "https://swap.9summits.io";

const CLI_VERSION = (pkg as { version?: string }).version ?? "0.0.0";

// Every hosted request is tagged so the deployment can tell CLI traffic from
// browser traffic in its logs (and rate-limit them separately if it ever needs
// to). No secret, no address, nothing user-identifying.
const CLIENT_HEADERS: Record<string, string> = {
  "user-agent": `swap-cli/${CLI_VERSION}`,
  "x-swap-client": "cli",
};

/** The same identification headers, for the `--browser` proxy in browser.ts. */
export function cliClientHeaders(): Record<string, string> {
  return { ...CLIENT_HEADERS };
}

// How many intermediary hop addresses we are willing to resolve one-by-one
// against /api/resolve-token. Route trees are short; this only guards against a
// pathological venue response turning one quote into dozens of round-trips.
const MAX_INTERMEDIARY_LOOKUPS = 12;

// ───────────────────────────── base resolution ──────────────────────────────

/**
 * Resolve the hosted API base for this run, or `null` for the local engine.
 *
 * Precedence: `--local` → `--hosted` → `SWAP_API_URL` → local. `SWAP_API_URL`
 * is read from `process.env` *after* `loadDotenv()`, so a value baked into a
 * public build (`.env.install` → `EMBEDDED_ENV`) turns hosted mode on by
 * default for that binary while a shell export still overrides it.
 */
export function resolveApiBase(
  opts: {
    hosted?: boolean;
    local?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): string | null {
  if (opts.hosted && opts.local) {
    throw new Error("--hosted and --local are mutually exclusive");
  }
  if (opts.local) return null;
  if (opts.hosted) return HOSTED_DEFAULT;
  const raw = (opts.env ?? process.env).SWAP_API_URL?.trim();
  if (!raw) return null;
  return normalizeBase(raw);
}

function normalizeBase(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `SWAP_API_URL is not a valid URL: ${JSON.stringify(raw)} ` +
        `(expected something like https://swap.9summits.io)`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `SWAP_API_URL must be an http(s) URL, got ${JSON.stringify(raw)}`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Join a base (possibly path-prefixed) with an absolute-rooted API path. */
function joinUrl(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Absolute URL for an order's submit leg. Async venues whose relayer needs a
 * server-held key come back with a *relative* `submit.url` (`/submit?venue=…`)
 * that the server rewrote; keyless relayers (cow / delta / ophis) keep their
 * absolute public URL and are returned untouched.
 */
export function remoteSubmitUrl(
  base: string,
  order: { submit: { url: string } },
): string {
  const url = order.submit.url;
  if (/^https?:\/\//i.test(url)) return url;
  return joinUrl(base, url);
}

// ───────────────────────────── transport ────────────────────────────────────

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function retryAfterSeconds(header: string | null): number {
  if (!header) return 60;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(header);
  if (Number.isFinite(at)) {
    return Math.max(1, Math.ceil((at - Date.now()) / 1000));
  }
  return 60;
}

async function errorFromBody(
  res: Response,
  base: string,
  path: string,
): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        detail =
          typeof parsed?.error === "string" ? parsed.error : text.slice(0, 300);
      } catch {
        // Not JSON (an HTML error page from a proxy, say) — the raw body is
        // still the most informative thing we can show.
        detail = text.slice(0, 300);
      }
    }
  } catch (e) {
    // Body unreadable (connection cut mid-response). Not silent: the reason is
    // folded into the error we are about to throw.
    detail = `unreadable error body (${messageOf(e)})`;
  }
  return detail || `${res.status} ${res.statusText} from ${base}${path}`;
}

async function hostedFetch(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = joinUrl(base, path);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...CLIENT_HEADERS,
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
      },
    });
  } catch (e) {
    throw new Error(
      `hosted API unreachable (${base}): ${messageOf(e)}. ` +
        `Retry later, or run with --local and your own keys`,
    );
  }
  if (res.status === 429) {
    throw new Error(
      `hosted API rate limited, retry in ${retryAfterSeconds(res.headers.get("retry-after"))} s`,
    );
  }
  if (!res.ok) {
    throw new Error(await errorFromBody(res, base, path));
  }
  return res;
}

async function postJson<T>(
  base: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await hostedFetch(base, path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

// ───────────────────────────── /api/mode ────────────────────────────────────

export type RemoteVenue = { name: Venue; kind: "sync" | "async" };

export type RemoteChain = {
  alias: string;
  chainId: number;
  name: string;
  explorer: string;
  nativeSymbol: string;
  wrappedNative: string | null;
};

export type RemoteMode = {
  apiVersion: number;
  chains: RemoteChain[];
  venues: RemoteVenue[];
  buyVenues: Venue[];
  defaultChain: string;
};

type ModeWire = {
  apiVersion?: unknown;
  chains?: unknown;
  venues?: unknown;
  buyVenues?: unknown;
  defaultChain?: unknown;
};

function isKnownVenue(name: unknown): name is Venue {
  return typeof name === "string" && (VENUES as readonly string[]).includes(name);
}

/**
 * Bootstrap the hosted session: contract version, chain table, venue list.
 *
 * The `apiVersion` check is deliberately strict — a deployment that predates
 * the versioning omits the key entirely, and its route rows carry none of the
 * fields the terminal renderers need (hops / router / tokenHints). Rendering a
 * silently degraded table would be worse than saying so.
 */
export async function remoteMode(base: string): Promise<RemoteMode> {
  const res = await hostedFetch(base, "/api/mode", {
    headers: { accept: "application/json" },
  });
  const raw = (await res.json()) as ModeWire;
  const got = typeof raw.apiVersion === "number" ? raw.apiVersion : null;
  if (got !== API_VERSION) {
    throw new Error(
      `hosted API contract mismatch (expected ${API_VERSION}, got ${got ?? "none"}); ` +
        "run `swap update`",
    );
  }

  const chains: RemoteChain[] = Array.isArray(raw.chains)
    ? raw.chains.flatMap((c) => {
        const row = c as Partial<RemoteChain>;
        if (typeof row?.alias !== "string" || typeof row?.chainId !== "number") {
          return [];
        }
        return [
          {
            alias: row.alias,
            chainId: row.chainId,
            name: typeof row.name === "string" ? row.name : row.alias,
            explorer: typeof row.explorer === "string" ? row.explorer : "",
            nativeSymbol:
              typeof row.nativeSymbol === "string" ? row.nativeSymbol : "",
            wrappedNative:
              typeof row.wrappedNative === "string" ? row.wrappedNative : null,
          },
        ];
      })
    : [];

  const venues: RemoteVenue[] = Array.isArray(raw.venues)
    ? raw.venues.flatMap((v) => {
        const row = v as { name?: unknown; kind?: unknown };
        if (!isKnownVenue(row?.name)) return [];
        return [
          { name: row.name, kind: row.kind === "async" ? "async" : "sync" },
        ];
      })
    : [];

  return {
    apiVersion: got,
    chains,
    venues,
    buyVenues: Array.isArray(raw.buyVenues)
      ? raw.buyVenues.filter(isKnownVenue)
      : [],
    defaultChain:
      typeof raw.defaultChain === "string" ? raw.defaultChain : "eth",
  };
}

// ───────────────────────────── /api/resolve-token ───────────────────────────

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function assertDecimals(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 36
  ) {
    throw new Error(
      `hosted API returned no usable decimals for ${label} ` +
        `(got ${JSON.stringify(value)}) — refusing to guess, decimals are safety-critical`,
    );
  }
  return value;
}

export async function remoteResolveToken(params: {
  base: string;
  chain: ChainInfo;
  input: string;
}): Promise<Token> {
  const t = await postJson<{
    address?: unknown;
    symbol?: unknown;
    name?: unknown;
    decimals?: unknown;
  }>(params.base, "/api/resolve-token", {
    chain: params.chain.alias,
    input: params.input,
  });
  if (typeof t.address !== "string" || !t.address) {
    throw new Error(
      `hosted API returned no address for ${JSON.stringify(params.input)} on ${params.chain.displayName}`,
    );
  }
  const decimals = assertDecimals(t.decimals, JSON.stringify(params.input));
  const symbol = typeof t.symbol === "string" && t.symbol ? t.symbol : shortAddr(t.address);
  return {
    address: t.address,
    symbol,
    name: typeof t.name === "string" && t.name ? t.name : symbol,
    decimals,
    chainId: params.chain.chainId,
    source: "hosted",
  };
}

/**
 * Hosted counterpart of `resolveAddresses` — label the intermediary hop tokens
 * of a route. One `/api/resolve-token` call per address (there is no batch
 * endpoint on the wire); failures degrade to the truncated-address label the
 * renderers already fall back to, so a missing symbol never fails the command.
 */
export async function remoteResolveAddresses(params: {
  base: string;
  chain: ChainInfo;
  addresses: string[];
}): Promise<Map<string, TokenHint>> {
  const out = new Map<string, TokenHint>();
  const unique = [...new Set(params.addresses.map((a) => a.toLowerCase()))].slice(
    0,
    MAX_INTERMEDIARY_LOOKUPS,
  );
  if (unique.length === 0) return out;
  const settled = await Promise.allSettled(
    unique.map((a) =>
      remoteResolveToken({ base: params.base, chain: params.chain, input: a }),
    ),
  );
  for (let i = 0; i < unique.length; i++) {
    const r = settled[i]!;
    const addr = unique[i]!;
    if (r.status === "fulfilled") {
      out.set(addr, {
        symbol: r.value.symbol,
        name: r.value.name,
        decimals: r.value.decimals,
      });
    } else {
      console.error(
        `! intermediate token lookup failed for ${addr}: ${messageOf(r.reason)}`,
      );
    }
  }
  return out;
}

// ───────────────────────────── quote ────────────────────────────────────────

export type RemoteQuoteParams = {
  base: string;
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  /** Fixed leg on sell (exact-in). */
  amountIn?: bigint;
  /** Fixed leg on buy (exact-out). */
  amountOut?: bigint;
  side: TradeSide;
  slippageBps: number;
  allowAsync: boolean;
  venues?: Venue[];
  disableOdosRfq?: boolean;
};

function quoteBody(p: RemoteQuoteParams): Record<string, unknown> {
  return {
    chain: p.chain.alias,
    tokenInAddress: p.tokenIn.address,
    tokenOutAddress: p.tokenOut.address,
    // The wire takes exactly one of amountIn / amountOut on the quote path.
    ...(p.side === "buy"
      ? { amountOut: (p.amountOut ?? 0n).toString() }
      : { amountIn: (p.amountIn ?? 0n).toString() }),
    side: p.side,
    slippageBps: p.slippageBps,
    allowAsync: p.allowAsync,
    ...(p.venues ? { venues: p.venues } : {}),
    ...(p.disableOdosRfq ? { disableOdosRfq: true } : {}),
  };
}

export type RouteMapContext = {
  side: TradeSide;
  /** The user's exact-out receive target — only set on `side: "buy"`. */
  targetAmountOut?: bigint;
};

function asAmount(v: unknown, field: string, venue: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw new Error(`hosted route for ${venue} is missing ${field}`);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function hopsFromWire(v: unknown): NormalizedHop[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((h) => {
    const row = h as Partial<NormalizedHop>;
    if (
      typeof row?.tokenIn !== "string" ||
      typeof row?.tokenOut !== "string" ||
      typeof row?.exchange !== "string" ||
      typeof row?.swapAmount !== "string"
    ) {
      return [];
    }
    return [row as NormalizedHop];
  });
}

function tokenHintsFromWire(v: unknown): Map<string, TokenHint> {
  const out = new Map<string, TokenHint>();
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [addr, hint] of Object.entries(v as Record<string, unknown>)) {
    const h = hint as Partial<TokenHint>;
    // A hint without real decimals is dropped rather than patched: the hints
    // feed the route-tree labels AND nothing else, but a bogus decimals here
    // would still be a lie in `--json`.
    if (typeof h?.decimals !== "number" || !Number.isInteger(h.decimals)) continue;
    out.set(addr.toLowerCase(), {
      symbol: typeof h.symbol === "string" ? h.symbol : shortAddr(addr),
      name: typeof h.name === "string" ? h.name : (h.symbol ?? addr),
      decimals: h.decimals,
    });
  }
  return out;
}

/**
 * Wire `RouteQuote` → `NormalizedQuote`, the shape every renderer consumes.
 *
 * Tolerant by design: a deployment that predates the hops/router/protocolFee/
 * tokenHints additions still yields a usable row (empty route tree, `router —`)
 * instead of crashing the table.
 *
 * **`buyRefine`** is the one lossy field: the wire carries a plain boolean
 * (the server's own refine bookkeeping is not serialized), while the local
 * `NormalizedQuote` carries `{targetAmountOut, seedAmountIn}`. We rebuild that
 * object from data we already hold — the receive target is exactly what the
 * user asked for (`--exact-out <amount>`, passed in as `targetAmountOut`), and
 * the seed pay is the route's own `amountIn`. That keeps every local consumer
 * (`allowanceCeiling`, the comparison block, `--json`) behaving identically to
 * the local engine. The reconstructed object is never sent back: hosted builds
 * post `{amountIn, amountOut, side:"buy"}` and the server redoes the refine
 * itself, so a divergence here can never leak into signed calldata.
 */
export function routeQuoteToNormalized(
  row: unknown,
  ctx: RouteMapContext,
): NormalizedQuote {
  const r = (row ?? {}) as Record<string, unknown>;
  if (typeof r.venue !== "string" || !r.venue) {
    throw new Error("hosted route row has no venue");
  }
  const venue = r.venue;
  const amountIn = asAmount(r.amountIn, "amountIn", venue);
  const amountOut = asAmount(r.amountOut, "amountOut", venue);
  const protocolFee = r.protocolFee;

  const quote: NormalizedQuote = {
    venue: venue as Venue,
    amountIn,
    amountOut,
    ...(typeof r.minAmountOut === "string" && r.minAmountOut
      ? { minAmountOut: r.minAmountOut }
      : {}),
    amountInUsd: numOrNull(r.amountInUsd),
    amountOutUsd: numOrNull(r.amountOutUsd),
    gasUnits: numOrNull(r.gasUnits),
    gasPriceWei: typeof r.gasPriceWei === "string" ? r.gasPriceWei : null,
    gasUsd: numOrNull(r.gasUsd),
    router: typeof r.router === "string" ? r.router : null,
    hops: hopsFromWire(r.hops),
    tokenHints: tokenHintsFromWire(r.tokenHints),
    protocolFee:
      protocolFee && typeof protocolFee === "object"
        ? (protocolFee as NormalizedQuote["protocolFee"])
        : null,
    raw: row,
  };
  if (r.buyRefine === true) {
    quote.buyRefine = {
      targetAmountOut: (ctx.targetAmountOut ?? BigInt(amountOut)).toString(),
      seedAmountIn: amountIn,
    };
  }
  return quote;
}

function venueResultFromRow(row: unknown, ctx: RouteMapContext): VenueResult {
  const venue = ((row ?? {}) as { venue?: unknown }).venue;
  const name = (typeof venue === "string" ? venue : "unknown") as Venue;
  try {
    return { venue: name, quote: routeQuoteToNormalized(row, ctx) };
  } catch (e) {
    return { venue: name, error: messageOf(e) };
  }
}

const DONE = Symbol("ndjson-done");

function eventToResult(
  line: string,
  ctx: RouteMapContext,
): VenueResult | typeof DONE | null {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch (e) {
    // One malformed line must not kill a stream that is otherwise fine —
    // logged, never swallowed.
    console.error(`! hosted quote stream: unparseable line (${messageOf(e)})`);
    return null;
  }
  switch (ev.type) {
    case "route":
      // Both shapes are accepted: the documented `{type:"route", route:{…}}`
      // envelope and a flattened `{type:"route", venue, …}` row.
      return venueResultFromRow(ev.route ?? ev, ctx);
    case "verror":
      return {
        venue: String(ev.venue ?? "unknown") as Venue,
        error: typeof ev.error === "string" ? ev.error : "venue failed",
      };
    case "fatal":
      throw new Error(
        typeof ev.error === "string" ? ev.error : "hosted quote stream failed",
      );
    case "done":
      return DONE;
    default:
      // `meta`, plus any event type added later: ignored on purpose so the CLI
      // survives additive contract changes.
      return null;
  }
}

/**
 * NDJSON lines → `VenueResult`s, in arrival order — the exact surface of
 * `fetchAllQuotesStream`. Split out from the fetch so it can be unit-tested by
 * feeding arbitrary chunk boundaries (a line split across two chunks included).
 */
export async function* venueResultsFromNdjson(
  chunks: AsyncIterable<string>,
  ctx: RouteMapContext,
): AsyncGenerator<VenueResult> {
  let buf = "";
  for await (const chunk of chunks) {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const out = eventToResult(line, ctx);
      if (out === DONE) return;
      if (out) yield out;
    }
  }
  const tail = buf.trim();
  if (tail) {
    const out = eventToResult(tail, ctx);
    if (out && out !== DONE) yield out;
  }
}

async function* decodeChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) yield tail;
        return;
      }
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/** `fetchAllQuotesStream` over the wire: one `VenueResult` per venue, as it settles. */
export async function* remoteQuoteStream(
  p: RemoteQuoteParams,
): AsyncGenerator<VenueResult> {
  const res = await hostedFetch(p.base, "/api/quote/stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
    },
    body: JSON.stringify(quoteBody(p)),
  });
  if (!res.body) {
    throw new Error(`hosted API returned an empty quote stream (${p.base})`);
  }
  yield* venueResultsFromNdjson(decodeChunks(res.body), {
    side: p.side,
    targetAmountOut: p.amountOut,
  });
}

/** `fetchAllQuotes` over the wire (non-streaming `/api/quote`). */
export async function remoteQuoteAll(
  p: RemoteQuoteParams,
): Promise<VenueResult[]> {
  const body = await postJson<{ routes?: unknown; unavailable?: unknown }>(
    p.base,
    "/api/quote",
    quoteBody(p),
  );
  const ctx: RouteMapContext = { side: p.side, targetAmountOut: p.amountOut };
  const out: VenueResult[] = [];
  if (Array.isArray(body.routes)) {
    for (const row of body.routes) out.push(venueResultFromRow(row, ctx));
  }
  // `unavailable` is optional on the wire and has been seen in both shapes
  // (bare venue names, or {venue, error} rows). Tolerate either.
  if (Array.isArray(body.unavailable)) {
    for (const u of body.unavailable) {
      if (typeof u === "string") {
        out.push({ venue: u as Venue, error: "unavailable" });
      } else if (u && typeof u === "object") {
        const row = u as { venue?: unknown; error?: unknown };
        if (typeof row.venue === "string") {
          out.push({
            venue: row.venue as Venue,
            error: typeof row.error === "string" ? row.error : "unavailable",
          });
        }
      }
    }
  }
  return out;
}

/** Single-venue quote — `fetchQuote` over the wire. Throws with the venue's own reason. */
export async function remoteQuoteSingle(
  p: RemoteQuoteParams & { venue: Venue },
): Promise<NormalizedQuote> {
  const results = await remoteQuoteAll({ ...p, venues: [p.venue] });
  const hit = results.find((r) => r.venue === p.venue) ?? results[0];
  if (hit && "quote" in hit) return hit.quote;
  if (hit) throw new Error(hit.error);
  throw new Error(`${p.venue} returned no quote from ${p.base}`);
}

// ───────────────────────────── build / assemble ─────────────────────────────

export type RemoteBuildResult = {
  result: BuildResult;
  approval: ApprovalForBrowser | null;
  assembleContext?: unknown;
  minAmountOut?: string;
};

function wireToken(t: Token): Record<string, unknown> {
  return {
    address: t.address,
    symbol: t.symbol,
    decimals: t.decimals,
    name: t.name,
  };
}

/**
 * `build()` over the wire. The CLI never sends its `NormalizedQuote`: the
 * server re-quotes the venue with the real sender before assembling (Odos
 * pathIds / Velora priceRoutes go stale within ~30s), which is also what makes
 * the exact-out sell-refine correct without trusting a client-side tag.
 */
export async function remoteBuild(p: {
  base: string;
  chain: ChainInfo;
  venue: string;
  sender: string;
  recipient?: string | null;
  slippageBps: number;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  /** Exact-out receive target; sent together with amountIn on `side: "buy"`. */
  amountOut?: bigint;
  side: TradeSide;
  odosNotCompact?: boolean;
  disableOdosRfq?: boolean;
}): Promise<RemoteBuildResult> {
  const payload = await postJson<Payload & { error?: string }>(
    p.base,
    "/api/build",
    {
      venue: p.venue,
      sender: p.sender,
      ...(p.recipient ? { recipient: p.recipient } : {}),
      slippageBps: p.slippageBps,
      chain: p.chain.alias,
      tokenIn: wireToken(p.tokenIn),
      tokenOut: wireToken(p.tokenOut),
      amountIn: p.amountIn.toString(),
      ...(p.side === "buy" && p.amountOut != null
        ? { amountOut: p.amountOut.toString(), side: "buy" }
        : { side: "sell" }),
      ...(p.odosNotCompact ? { odosNotCompact: true } : {}),
      ...(p.disableOdosRfq ? { disableOdosRfq: true } : {}),
    },
  );

  let result: BuildResult;
  if (payload.kind === "tx") {
    if (!payload.tx) throw new Error("hosted build returned kind=tx with no tx");
    result = { kind: "tx", ...payload.tx };
  } else if (payload.kind === "order") {
    if (!payload.order) {
      throw new Error("hosted build returned kind=order with no order");
    }
    result = payload.order;
  } else if (payload.kind === "permit-tx") {
    if (!payload.permitTx) {
      throw new Error("hosted build returned kind=permit-tx with no permitTx");
    }
    result = payload.permitTx;
  } else {
    throw new Error(
      `hosted build returned an unknown kind: ${JSON.stringify(payload.kind)}`,
    );
  }

  return {
    result,
    approval: payload.approval ?? null,
    assembleContext: payload.assembleContext,
    minAmountOut: payload.minAmountOut,
  };
}

/** Permit2 second leg over the wire (`POST /assemble`). */
export async function remoteAssemble(p: {
  base: string;
  signature: string;
  context: unknown;
}): Promise<NormalizedTx> {
  const body = await postJson<{ tx?: NormalizedTx; error?: string }>(
    p.base,
    "/assemble",
    { signature: p.signature, context: p.context },
  );
  if (!body.tx) {
    throw new Error(body.error ?? "hosted /assemble returned no tx");
  }
  return body.tx;
}

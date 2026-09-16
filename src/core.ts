// Commander-free composition layer over the existing CLI primitives.
// Consumed by `src/serve.ts` (the interactive dApp server). The terminal
// CLI (`index.ts`) keeps its own inline orchestration; this module
// deliberately MIRRORS that logic (same helpers, same params) so both the
// CLI and the dApp quote/build identically — without coupling serve.ts to
// index.ts's commander closure (importing index.ts would run main()).
//
// Nothing here writes to the console or touches a TTY: every function takes
// plain params and returns plain data, so it's safe to call from an HTTP
// handler. Errors throw (the caller maps them to HTTP status codes).

import { resolveChain, CHAINS, type ChainInfo } from "./chains.ts";
import {
  resolveToken,
  resolveAddresses,
  NATIVE_SENTINEL,
  type Token,
} from "./tokens.ts";
import { builtinTokens } from "./tokens_builtin.ts";
import { toBaseUnits } from "./amount.ts";
import { toChecksumAddress } from "./checksum.ts";
import type { TradeSide } from "./trade_side.ts";
import {
  getRpcUrl,
  getErc20Balance,
  getNativeBalance,
  getAllowance,
  buildApproveData,
} from "./rpc.ts";
import {
  fetchAllQuotes,
  fetchAllQuotesStream,
  fetchQuote,
  pickBest,
  build,
  assemblePermitTx,
  availableVenues,
  skippedVenues,
  disabledVenues,
  isAsyncVenue,
  type Venue,
  type VenueResult,
  type NormalizedQuote,
  type NormalizedTx,
  type BuildResult,
} from "./venues/index.ts";
import { fillGasUsd, fillGasUsdAll } from "./gas_usd.ts";
import { GROSS } from "../shared/rank.ts";
import { detectWrap, buildWrapTx } from "./wrap.ts";
import { buildSendTx } from "./send.ts";

// ───────────────────────────── token resolution ─────────────────────────

export type ResolvedPair = {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
};

export async function resolveTokenPair(p: {
  chainAlias: string;
  tokenInInput: string;
  tokenOutInput: string;
}): Promise<ResolvedPair> {
  const chain = resolveChain(p.chainAlias);
  const [tokenIn, tokenOut] = await Promise.all([
    resolveToken(p.tokenInInput, chain),
    resolveToken(p.tokenOutInput, chain),
  ]);
  return { chain, tokenIn, tokenOut };
}

export async function resolveOneToken(p: {
  chainAlias: string;
  input: string;
}): Promise<Token> {
  const chain = resolveChain(p.chainAlias);
  return resolveToken(p.input, chain);
}

// ───────────────────────────── curated token list ───────────────────────

export type ListedToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
};

type KsToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number | string;
  logoURI?: string;
};

const tokenListCache = new Map<number, { at: number; tokens: ListedToken[] }>();
const tokenListInflight = new Map<number, Promise<ListedToken[]>>();
const TOKEN_LIST_TTL_MS = 10 * 60 * 1000;

// Curated per-chain token list — the KyberSwap ks-setting whitelist (same
// source `resolveToken` already trusts). Powers the picker's default list.
// The native token is prepended so it's always selectable. Cached per chain.
// Concurrent cache-miss callers share one in-flight fetch: the token picker
// can fire hundreds of /api/icon lookups that all need this list, and without
// coalescing each one would re-hit ks-setting.
export async function tokenList(chainAlias: string): Promise<ListedToken[]> {
  const chain = resolveChain(chainAlias);
  const cached = tokenListCache.get(chain.chainId);
  if (cached && Date.now() - cached.at < TOKEN_LIST_TTL_MS) return cached.tokens;
  const pending = tokenListInflight.get(chain.chainId);
  if (pending) return pending;
  const load = loadTokenList(chain).finally(() => {
    tokenListInflight.delete(chain.chainId);
  });
  tokenListInflight.set(chain.chainId, load);
  return load;
}

async function loadTokenList(chain: ChainInfo): Promise<ListedToken[]> {
  // ks-setting caps pageSize at 100 (200+ → 400). Paginate a few pages so
  // the picker shows a generous curated list; arbitrary tokens are still
  // reachable via paste-address → /api/resolve-token.
  // A chain with a builtin table (Robinhood 4663) has its full curated set
  // locally, so a ks-setting outage must degrade to builtin-only instead of
  // blanking the picker; chains with no builtins keep the hard failure.
  const hasBuiltins = builtinTokens(chain.chainId).length > 0;
  const raw: KsToken[] = [];
  for (let page = 1; page <= 3; page++) {
    const url =
      `https://ks-setting.kyberswap.com/api/v1/tokens` +
      `?chainIds=${chain.chainId}&page=${page}&pageSize=100&isWhitelisted=true`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      if (page === 1 && !hasBuiltins) throw new Error(`ks-setting ${res.status} ${res.statusText}`);
      if (page === 1) console.warn(`core: ks-setting ${res.status} for chain ${chain.chainId} — serving builtin list only`);
      break; // got at least one page (or builtins cover us); stop here
    }
    const json = (await res.json()) as { data?: { tokens?: KsToken[] } };
    const got = json.data?.tokens ?? [];
    raw.push(...got);
    if (got.length < 100) break; // last page
  }

  // Native-asset glyph (DeFiLlama chain-icon CDN), keyed by native symbol —
  // the ks-setting list never includes the native token, so it'd otherwise
  // render as a tinted monogram. ETH covers eth/arb/base/op/unichain.
  const NATIVE_LOGO: Record<string, string> = {
    ETH: "https://icons.llamao.fi/icons/chains/rsz_ethereum?w=64&h=64",
    AVAX: "https://icons.llamao.fi/icons/chains/rsz_avalanche?w=64&h=64",
    BNB: "https://icons.llamao.fi/icons/chains/rsz_binance?w=64&h=64",
    HYPE: "https://icons.llamao.fi/icons/chains/rsz_hyperliquid?w=64&h=64",
    MON: "https://icons.llamao.fi/icons/chains/rsz_monad?w=64&h=64",
    XPL: "https://icons.llamao.fi/icons/chains/rsz_plasma?w=64&h=64",
    POL: "https://icons.llamao.fi/icons/chains/rsz_polygon?w=64&h=64",
    XDAI: "https://icons.llamao.fi/icons/chains/rsz_gnosis?w=64&h=64",
  };
  const native: ListedToken = {
    address: NATIVE_SENTINEL,
    symbol: chain.nativeSymbol,
    name: chain.nativeSymbol,
    decimals: 18,
    ...(NATIVE_LOGO[chain.nativeSymbol] ? { logoURI: NATIVE_LOGO[chain.nativeSymbol] } : {}),
  };
  // On a chain whose gas token is an ERC20 (Arc: USDC at 0x3600…0000) the
  // sentinel is not a tradeable asset — the builtin table's entry for that
  // ERC20 leads the list instead. `seen` still holds the sentinel so nothing
  // downstream can slip a 0xeee… row back in.
  const seen = new Set<string>([NATIVE_SENTINEL]);
  const tokens: ListedToken[] = chain.nativeErc20 ? [] : [native];
  // Builtin static tables (on-chain-verified) next, so chains KyberSwap
  // doesn't index (Robinhood 4663) still list their full curated set. For
  // indexed chains builtinTokens() is empty and this loop is a no-op — the
  // ks-setting list below is unchanged.
  for (const b of builtinTokens(chain.chainId)) {
    const addr = b.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    tokens.push({
      address: addr,
      symbol: b.symbol,
      name: b.name,
      decimals: b.decimals,
      ...(b.logoURI ? { logoURI: b.logoURI } : {}),
    });
  }
  for (const t of raw) {
    if (Number(t.chainId) !== chain.chainId) continue;
    const addr = t.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    tokens.push({
      address: addr,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      ...(t.logoURI ? { logoURI: t.logoURI } : {}),
    });
  }
  await fillMissingLogos(chain.chainId, tokens);
  tokenListCache.set(chain.chainId, { at: Date.now(), tokens });
  return tokens;
}

// ── token icons: Uniswap interface GraphQL back-fill ────────────────────────
// Same icon source the Uniswap app uses (`token.project.logoUrl`, CoinGecko-
// hosted images). Only fires for tokens the curated sources left without a
// logoURI (Robinhood builtins are baked statically in tokens_builtin.ts, so
// this mostly covers ks-setting gaps on the other chains). Best-effort: any
// failure (gateway blocking datacenter IPs, timeout) logs and leaves the
// letter-badge fallback — never fails the token list. Cached along with it.
const UNISWAP_GQL_CHAIN: Record<number, string> = {
  1: "ETHEREUM",
  10: "OPTIMISM",
  56: "BNB",
  130: "UNICHAIN",
  137: "POLYGON",
  8453: "BASE",
  42161: "ARBITRUM",
  43114: "AVALANCHE",
  4663: "ROBINHOOD",
  // 100 (Gnosis) is not in their Chain enum — skipped.
  // 999 (HyperEVM) is not in their Chain enum — skipped.
  // 57073 (Ink) — Chain enum introspection blocked; skipped.
  // 5042 (Arc) — not verified against their Chain enum; skipped. Arc's
  // builtins ship their own logoURI, so the picker is unaffected.
};

async function fillMissingLogos(chainId: number, tokens: ListedToken[]): Promise<void> {
  const gqlChain = UNISWAP_GQL_CHAIN[chainId];
  if (!gqlChain) return;
  const missing = tokens.filter((t) => !t.logoURI && t.address !== NATIVE_SENTINEL);
  if (missing.length === 0) return;
  const byAddr = new Map(missing.map((t) => [t.address, t]));
  try {
    // Chunked so a long tail can't produce an oversized GraphQL request.
    for (let i = 0; i < missing.length; i += 60) {
      const chunk = missing.slice(i, i + 60);
      const res = await fetch("https://interface.gateway.uniswap.org/v1/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.uniswap.org",
        },
        body: JSON.stringify({
          query:
            "query T($contracts: [ContractInput!]!) { tokens(contracts: $contracts) { address project { logoUrl } } }",
          variables: {
            contracts: chunk.map((t) => ({ chain: gqlChain, address: t.address })),
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = (await res.json()) as {
        data?: { tokens?: ({ address: string; project?: { logoUrl?: string | null } | null } | null)[] };
      };
      for (const t of json.data?.tokens ?? []) {
        const logo = t?.project?.logoUrl;
        if (!t || !logo) continue;
        const target = byAddr.get(t.address.toLowerCase());
        if (target) target.logoURI = logo;
      }
    }
  } catch (e) {
    console.warn(
      `core: uniswap logo back-fill failed for chain ${chainId} (${(e as Error).message}) — letter badges for ${missing.length} tokens`,
    );
  }
}

// ───────────────────────────── balances ─────────────────────────────────

// Batched balanceOf / native-balance reads for the connected wallet. Powers
// the MAX button and per-token balance display. Returns base-unit strings
// keyed by lowercased address. Per-token failures degrade to "0" (one bad
// token shouldn't blank the whole panel) — they're logged, not swallowed.
export async function tokenBalances(p: {
  chainAlias: string;
  owner: string;
  tokens: string[];
}): Promise<Record<string, string>> {
  const chain = resolveChain(p.chainAlias);
  const rpc = getRpcUrl(chain);
  const out: Record<string, string> = {};
  await Promise.all(
    p.tokens.map(async (addr) => {
      const lc = addr.toLowerCase();
      try {
        const bal =
          lc === NATIVE_SENTINEL
            ? await getNativeBalance(rpc, p.owner)
            : await getErc20Balance({ rpc, token: addr, owner: p.owner });
        out[lc] = bal.toString();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`! balance read failed for ${lc}: ${msg}`);
        out[lc] = "0";
      }
    }),
  );
  return out;
}

// ───────────────────────────── amount handling ──────────────────────────

// Mirrors index.ts: "max" reads the wallet balance (native reserves 0.001
// for gas); otherwise human → base units. `sender` required for max.
export async function resolveAmountIn(p: {
  amountStr: string;
  tokenIn: Token;
  chain: ChainInfo;
  sender?: string;
}): Promise<bigint> {
  if (p.amountStr.toLowerCase() === "max") {
    if (!p.sender) throw new Error("amount=max requires a connected wallet");
    const rpc = getRpcUrl(p.chain);
    const isNative = p.tokenIn.address.toLowerCase() === NATIVE_SENTINEL;
    if (isNative) {
      const bal = await getNativeBalance(rpc, p.sender);
      const reserve = 1_000_000_000_000_000n; // 0.001 native gas reserve
      if (bal <= reserve) {
        throw new Error(`balance ${bal} below the 0.001 ${p.tokenIn.symbol} gas reserve`);
      }
      return bal - reserve;
    }
    const bal = await getErc20Balance({ rpc, token: p.tokenIn.address, owner: p.sender });
    if (bal === 0n) throw new Error(`0 ${p.tokenIn.symbol} balance`);
    return bal;
  }
  return toBaseUnits(p.amountStr, p.tokenIn.decimals);
}

// ───────────────────────────── quoting ──────────────────────────────────

export type QuoteAllResult = {
  best: { venue: Venue; quote: NormalizedQuote } | null;
  results: VenueResult[];
};

// Runs every available venue (the `-v all` engine) and back-fills gas USD.
// No streaming / no progress callback — serve.ts returns the full set.
export async function quoteAll(p: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  amountIn?: bigint;
  amountOut?: bigint;
  side?: TradeSide;
  slippageBps: number;
  allowAsync: boolean;
  venues?: Venue[];
  /** Odos V2/V3: send disableRFQs:true (CLI --disableodosrfq / dApp Advanced). */
  disableOdosRfq?: boolean;
}): Promise<QuoteAllResult> {
  const side = p.side ?? "sell";
  const results = await fetchAllQuotes({
    chain: p.chain,
    tokenIn: p.tokenIn.address,
    tokenOut: p.tokenOut.address,
    amountIn: p.amountIn,
    amountOut: p.amountOut,
    side,
    tokenInDecimals: p.tokenIn.decimals,
    tokenOutDecimals: p.tokenOut.decimals,
    slippageBps: p.slippageBps,
    allowAsync: p.allowAsync,
    venues: p.venues,
    disableOdosRfq: p.disableOdosRfq,
  });
  await fillGasUsdAll(results, p.chain);
  const { best } = pickBest(results, side, GROSS);
  return { best, results };
}

// Streaming variant: yields each VenueResult as soon as its venue settles
// (gas USD back-filled per-result), so the dApp can render routes live as they
// arrive instead of waiting for the slowest venue (e.g. curve's cold init).
export async function* quoteAllStream(p: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  amountIn?: bigint;
  amountOut?: bigint;
  side?: TradeSide;
  slippageBps: number;
  allowAsync: boolean;
  venues?: Venue[];
  /** Odos V2/V3: send disableRFQs:true (CLI --disableodosrfq / dApp Advanced). */
  disableOdosRfq?: boolean;
}): AsyncGenerator<VenueResult> {
  const side = p.side ?? "sell";
  for await (const r of fetchAllQuotesStream({
    chain: p.chain,
    tokenIn: p.tokenIn.address,
    tokenOut: p.tokenOut.address,
    amountIn: p.amountIn,
    amountOut: p.amountOut,
    side,
    tokenInDecimals: p.tokenIn.decimals,
    tokenOutDecimals: p.tokenOut.decimals,
    slippageBps: p.slippageBps,
    allowAsync: p.allowAsync,
    venues: p.venues,
    disableOdosRfq: p.disableOdosRfq,
  })) {
    if ("quote" in r) await fillGasUsd(r.quote, p.chain);
    yield r;
  }
}

// Fresh single-venue quote — used at build time so the quote handed to
// build() is current (Odos pathIds / Velora priceRoutes go stale within
// ~30s, and the CLI dodges this by quoting+building back-to-back; the dApp
// has a user-paced gap between /api/quote and /api/build, so we re-quote).
export async function quoteSingle(p: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  amountIn?: bigint;
  amountOut?: bigint;
  side?: TradeSide;
  slippageBps: number;
  venue: Venue;
  /** Odos V2/V3: send disableRFQs:true (CLI --disableodosrfq / dApp Advanced). */
  disableOdosRfq?: boolean;
}): Promise<NormalizedQuote> {
  return fetchQuote({
    venue: p.venue,
    chain: p.chain,
    tokenIn: p.tokenIn.address,
    tokenOut: p.tokenOut.address,
    amountIn: p.amountIn,
    amountOut: p.amountOut,
    side: p.side ?? "sell",
    tokenInDecimals: p.tokenIn.decimals,
    tokenOutDecimals: p.tokenOut.decimals,
    slippageBps: p.slippageBps,
    disableOdosRfq: p.disableOdosRfq,
  });
}

// ───────────────────────────── route graph ──────────────────────────────

export type GraphHop = {
  from: string; // tokenIn symbol
  to: string; // tokenOut symbol
  exchange: string; // protocol / pool label
  swapAmount: string; // tokenIn base units routed through this hop
  approxAmount?: boolean; // swapAmount is a split weight in the ROUTE input token, not tokenIn — don't humanise
  amountOut?: string; // hop output in tokenOut base units — only when the venue reports it
  fromName: string; // tokenIn full name (e.g. "Wrapped Ether") — hover tooltip
  fromDecimals: number; // tokenIn decimals — humanises swapAmount in the tooltip
  toDecimals: number; // tokenOut decimals — humanises amountOut in the tooltip
};

// Resolve a venue quote's `hops[]` into a symbol-labelled edge list for the
// dApp's graphical route view. Symbols come from (in priority): the pair
// endpoints, the venue's own tokenHints (Odos ships these), then a batched
// ks-setting lookup for any remaining intermediaries; unknown addresses fall
// back to a short 0x… label so the graph never blanks out.
export async function resolveRouteHops(p: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  quote: NormalizedQuote;
}): Promise<GraphHop[]> {
  // Per-address metadata (symbol + full name + decimals), so the dApp can both
  // label nodes and render a rich hover tooltip (name, share %, humanised amount).
  type HopMeta = { symbol: string; name: string; decimals: number };
  const meta = new Map<string, HopMeta>();
  const put = (addr: string, m: HopMeta) => meta.set(addr.toLowerCase(), m);
  put(p.tokenIn.address, { symbol: p.tokenIn.symbol, name: p.tokenIn.name, decimals: p.tokenIn.decimals });
  put(p.tokenOut.address, { symbol: p.tokenOut.symbol, name: p.tokenOut.name, decimals: p.tokenOut.decimals });
  put(NATIVE_SENTINEL, { symbol: p.chain.nativeSymbol, name: p.chain.nativeSymbol, decimals: 18 });
  // Hints only FILL unknown addresses — they never override the pair
  // endpoints (or the sentinel) we resolved ourselves. Venue metadata can be
  // wrong: OpenOcean reports Arc USDC (0x3600…0000) as 18 decimals when the
  // chain says 6, which would mis-humanise every hop amount in the tooltip.
  for (const [addr, hint] of p.quote.tokenHints) {
    if (meta.has(addr.toLowerCase())) continue;
    put(addr, { symbol: hint.symbol, name: hint.name, decimals: hint.decimals });
  }
  const unknown = new Set<string>();
  for (const h of p.quote.hops) {
    for (const a of [h.tokenIn, h.tokenOut]) {
      const lc = a.toLowerCase();
      if (!meta.has(lc) && lc.startsWith("0x") && lc !== NATIVE_SENTINEL) {
        unknown.add(lc);
      }
    }
  }
  if (unknown.size > 0) {
    const resolved = await resolveAddresses([...unknown], p.chain);
    for (const [addr, t] of resolved) {
      put(addr, { symbol: t.symbol, name: t.name, decimals: t.decimals });
    }
  }
  const short = (a: string) =>
    a.startsWith("0x") && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  const symOf = (a: string) => meta.get(a.toLowerCase())?.symbol ?? short(a);
  const nameOf = (a: string) =>
    meta.get(a.toLowerCase())?.name ?? meta.get(a.toLowerCase())?.symbol ?? short(a);
  // Unknown decimals default to 18 — this value only humanises the tooltip
  // amount (never calldata), so a display-side default is safe here.
  const decOf = (a: string) => meta.get(a.toLowerCase())?.decimals ?? 18;
  return p.quote.hops.map((h) => ({
    from: symOf(h.tokenIn),
    to: symOf(h.tokenOut),
    exchange: h.exchange,
    swapAmount: h.swapAmount,
    approxAmount: h.approxAmount,
    amountOut: h.amountOut,
    fromName: nameOf(h.tokenIn),
    fromDecimals: decOf(h.tokenIn),
    toDecimals: decOf(h.tokenOut),
  }));
}

// ───────────────────────────── build ────────────────────────────────────

// Builds the executable artifact for a chosen venue, OR short-circuits the
// wrap/unwrap and send pseudo-venues exactly like index.ts. Returns the
// BuildResult discriminated union (tx | order | permit-tx).
export async function buildForVenue(p: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  /** Fixed receive amount for exact-out (side="buy"). Forwarded to build(). */
  amountOut?: bigint;
  /** Exact-in ("sell", default) vs exact-out ("buy"). Threaded to build() so
   * adapters that read params.side (velora/matcha) build the right direction —
   * without it they silently fall back to sell. */
  side?: TradeSide;
  sender: string;
  slippageBps: number;
  quote: NormalizedQuote;
  venue: string;
  recipient?: string | null;
  /** Odos V2: force compact:false on the build re-quote (CLI --odosnotcompact). */
  odosNotCompact?: boolean;
  /** Odos V2/V3: send disableRFQs:true (CLI --disableodosrfq / dApp Advanced). */
  disableOdosRfq?: boolean;
}): Promise<BuildResult> {
  // send wins over wrap detection: the dApp keeps a tokenOut selected in the
  // Send tab, so a native↔wrapped pair would otherwise turn a transfer into a
  // deposit()/withdraw() (the CLI guards the same way via `isSend`).
  if (p.venue !== "send") {
    // Native ↔ wrapped short-circuit (matches detectWrap in the CLI).
    const wrapMode = detectWrap({
      chain: p.chain,
      tokenInAddress: p.tokenIn.address,
      tokenOutAddress: p.tokenOut.address,
    });
    if (wrapMode || p.venue === "wrap") {
      if (!wrapMode) throw new Error("venue=wrap but tokens are not a native↔wrapped pair");
      const tx = buildWrapTx({ chain: p.chain, sender: p.sender, amountIn: p.amountIn, mode: wrapMode });
      return { kind: "tx", ...tx };
    }
  }
  if (p.venue === "send") {
    if (!p.recipient) throw new Error("send requires a recipient address");
    const tx = buildSendTx({
      chain: p.chain,
      sender: p.sender,
      recipient: p.recipient,
      token: p.tokenIn,
      amount: p.amountIn,
    });
    return { kind: "tx", ...tx };
  }
  return build(p.venue as Venue, {
    chain: p.chain,
    tokenIn: p.tokenIn.address,
    tokenOut: p.tokenOut.address,
    tokenInDecimals: p.tokenIn.decimals,
    tokenOutDecimals: p.tokenOut.decimals,
    amountIn: p.amountIn,
    amountOut: p.amountOut,
    side: p.side,
    sender: p.sender,
    slippageBps: p.slippageBps,
    quote: p.quote,
    odosNotCompact: p.odosNotCompact,
    disableOdosRfq: p.disableOdosRfq,
  });
}

// ───────────────────────────── allowance ────────────────────────────────

export type AllowanceResult = {
  current: bigint;
  needed: bigint;
  sufficient: boolean;
  approveTx: NormalizedTx | null;
};

// Whether an ERC20 approval check applies. Native input, wrap/unwrap and
// send never need an approval (msg.value / msg.sender's own balance).
export function needsAllowanceCheck(tokenIn: Token, venue: string, chain: ChainInfo): boolean {
  if (tokenIn.address.toLowerCase() === NATIVE_SENTINEL) return false;
  if (venue === "send" || venue === "wrap") return false;
  // Chains with no wrapped-native (Arc) have no unwrap path to exempt.
  const wrapped = chain.wrappedNative;
  if (wrapped && detectWrap({ chain, tokenInAddress: tokenIn.address, tokenOutAddress: wrapped })) {
    // unwrap path (WETH in) — withdraw() needs no approval
    if (tokenIn.address.toLowerCase() === wrapped.toLowerCase()) return false;
  }
  return true;
}

/**
 * True when the built tx pays its input out of msg.value even though the
 * input is an ERC20 — the case on chains whose gas token IS an ERC20 (Arc:
 * USDC at 0x3600…0000). Uniswap's Arc build sets
 * `value = amountIn * 10^12` and settles from the router's own balance
 * (v4 SETTLE payerIsUser=false), so an approval would be a wasted extra tx.
 *
 * Deliberately narrow — chain has a nativeErc20, input IS it, sync tx, value
 * > 0 — and fail-safe in the right direction: if some future build both set
 * a value AND pulled via Permit2/transferFrom, skipping the approval makes
 * that tx revert (the user loses gas, nothing else). The opposite mistake,
 * granting an allowance that isn't needed, leaves standing spend authority.
 */
export function inputPaidViaValue(
  chain: ChainInfo,
  tokenInAddress: string,
  build: { kind: BuildResult["kind"]; value?: string | null } | null,
): boolean {
  if (!chain.nativeErc20) return false;
  if (!build || build.kind !== "tx") return false;
  if (tokenInAddress.toLowerCase() !== chain.nativeErc20.toLowerCase()) return false;
  return BigInt(build.value ?? "0") > 0n;
}

// Reads allowance(owner, spender) and, when short, builds an exact-amount
// approve(spender, amountIn) tx. Mirrors index.ts (exact, not infinite).
export async function checkAllowance(p: {
  chain: ChainInfo;
  tokenIn: Token;
  amountIn: bigint;
  sender: string;
  spender: string;
}): Promise<AllowanceResult> {
  const rpc = getRpcUrl(p.chain);
  const current = await getAllowance({
    rpc,
    token: p.tokenIn.address,
    owner: p.sender,
    spender: p.spender,
  });
  const sufficient = current >= p.amountIn;
  const approveTx: NormalizedTx | null = sufficient
    ? null
    : {
        to: toChecksumAddress(p.tokenIn.address),
        from: p.sender,
        data: buildApproveData(p.spender, p.amountIn),
        value: "0",
        gas: null,
        gasPrice: null,
        maxPriorityFeePerGas: null,
        spender: p.spender,
        chainId: p.chain.chainId,
      };
  return { current, needed: p.amountIn, sufficient, approveTx };
}

// ───────────────────────────── permit-tx assemble ───────────────────────

export async function assemble(p: {
  venue: Venue;
  chain: ChainInfo;
  sender: string;
  signature: string;
  quote: NormalizedQuote;
}): Promise<NormalizedTx> {
  return assemblePermitTx({
    venue: p.venue as Parameters<typeof assemblePermitTx>[0]["venue"],
    chain: p.chain,
    sender: p.sender,
    signature: p.signature,
    quote: p.quote,
  });
}

// ───────────────────────────── metadata ─────────────────────────────────

export function listChains() {
  return Object.values(CHAINS).map((c) => ({
    alias: c.alias,
    chainId: c.chainId,
    name: c.displayName,
    explorer: c.explorer,
    nativeSymbol: c.nativeSymbol,
    wrappedNative: c.wrappedNative,
  }));
}

// Venues actually reachable with the current env keys + async opt-in, plus
// the ones skipped (so the UI can grey them out / explain the missing key).
// Env-disabled venues (SWAP_DISABLE_VENUES) are excluded entirely —
// availableVenues already drops them, so they never appear in the listing.
export function listVenues(allowAsync: boolean) {
  const ready = availableVenues({ allowAsync: true }); // full set, kind-tagged below
  const reachable = new Set(availableVenues({ allowAsync }));
  const skipped = skippedVenues({ allowAsync });
  const skipMap = new Map(skipped.map((s) => [s.venue, s]));
  const disabled = disabledVenues();
  return ready
    .filter((v) => !disabled.has(v))
    .map((v) => ({
      name: v,
      kind: isAsyncVenue(v) ? ("async" as const) : ("sync" as const),
      reachable: reachable.has(v),
      skip: skipMap.get(v) ?? null,
    }));
}

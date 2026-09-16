import type { ChainInfo } from "./chains.ts";
import { getErc20Decimals, getRpcUrl, RpcConfigError } from "./rpc.ts";
import { builtinBySymbol, builtinByAddress } from "./tokens_builtin.ts";

export type Token = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  source: string;
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
export const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export function isAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}

async function fetchOnchainDecimals(
  chain: ChainInfo,
  address: string,
): Promise<number | null> {
  try {
    const rpc = getRpcUrl(chain);
    return await getErc20Decimals({ rpc, token: address });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof RpcConfigError) {
      console.error(`! on-chain decimals() skipped for ${address}: ${msg}`);
    } else {
      console.error(`! on-chain decimals() failed for ${address}: ${msg}`);
    }
    return null;
  }
}

// Determine a token's decimals, preferring the off-chain value when present
// (trusted sources already verified it) and falling back to an on-chain
// decimals() call. Throws if neither source yields a value — never silently
// returns a guess, because a wrong decimals rescales the amount by 10^N and
// corrupts both the quote and the built calldata.
async function resolveDecimals(
  chain: ChainInfo,
  address: string,
  offChain: number | null | undefined,
): Promise<number> {
  if (typeof offChain === "number") return offChain;
  const onchain = await fetchOnchainDecimals(chain, address);
  if (onchain !== null) return onchain;
  throw new Error(
    `could not determine decimals for ${address} on ${chain.displayName}. ` +
      `Off-chain sources did not provide it and on-chain decimals() was unavailable. ` +
      `Set ALCHEMY_API_KEY (or ${chain.alias.toUpperCase()}_RPC_URL / RPC_URL_${chain.chainId}) ` +
      `to enable on-chain verification, or pass a token that's indexed by KyberSwap / CoinGecko.`,
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

// Sleep helper for the single rate-limit backoff. The wait is deliberately
// short and bounded (see CG_RETRY_CAP_MS): this runs both inside a CLI
// invocation the user is watching and inside serverless handlers with a hard
// time budget, so a long sleep turns a 429 into a frozen terminal or an
// opaque 504 instead of a clean, actionable error.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** CoinGecko answered 429 and the single retry did too. Typed so callers can
 *  stop early (candidate loop) or fall through (address path → on-chain). */
export class CoinGeckoRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinGeckoRateLimitError";
  }
}

const CG_TIMEOUT_MS = 10_000; // per-attempt request timeout
const CG_RETRY_CAP_MS = 5_000; // max wait before the one retry (serverless-safe)
const CG_RETRY_DEFAULT_MS = 2_000; // 429 with no / garbage Retry-After
const CG_COOLDOWN_MIN_MS = 60_000; // free tier resets per minute
const CG_COOLDOWN_MAX_MS = 5 * 60_000;

// Raw `Retry-After` in ms — numeric seconds or HTTP-date form — or null when
// the header is absent or garbage. Uncapped; callers clamp to their own budget.
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(when - Date.now(), 0);
  return null;
}

/** Wait before the single 429 retry, capped so we never blow the time budget. */
export function coinGeckoRetryDelayMs(header: string | null): number {
  const raw = parseRetryAfterMs(header);
  if (raw === null) return CG_RETRY_DEFAULT_MS;
  return Math.min(raw, CG_RETRY_CAP_MS);
}

/** How long to stop calling CoinGecko entirely after a persistent 429. */
export function coinGeckoCooldownMs(header: string | null): number {
  const raw = parseRetryAfterMs(header) ?? 0;
  return Math.min(Math.max(raw, CG_COOLDOWN_MIN_MS), CG_COOLDOWN_MAX_MS);
}

// Circuit breaker: after a persistent 429 every further CoinGecko call fails
// fast until this timestamp. Without it the second token of a pair, the
// address path's fallback lookup, the next request on the long-lived dApp
// server and a warm serverless instance all re-hit an API that just told us
// to back off — each paying the retry wait again.
let rateLimitedUntil = 0;

function fmtWait(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

// CoinGecko-aware fetch. Per-attempt AbortSignal timeout (a stalled connection
// must not hang the command), one retry on 429 honoring Retry-After but capped,
// then a typed CoinGeckoRateLimitError plus a cooldown so the rest of the run
// stops hammering. Other errors bubble exactly as before.
async function fetchCoinGecko<T>(url: string): Promise<T> {
  const remaining = rateLimitedUntil - Date.now();
  if (remaining > 0) {
    throw new CoinGeckoRateLimitError(
      `rate limited (HTTP 429) — backing off, retry in ~${Math.ceil(remaining / 1000)}s, ` +
        `or pass the token's 0x address`,
    );
  }

  const tryOnce = async (): Promise<Response> =>
    fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CG_TIMEOUT_MS),
    });

  let res = await tryOnce();
  if (res.status === 429) {
    const waitMs = coinGeckoRetryDelayMs(res.headers.get("retry-after"));
    console.error(`! coingecko rate limited (429), retrying in ${fmtWait(waitMs)}…`);
    await sleep(waitMs);
    res = await tryOnce();
  }
  if (res.status === 429) {
    const cooldownMs = coinGeckoCooldownMs(res.headers.get("retry-after"));
    rateLimitedUntil = Date.now() + cooldownMs;
    console.error(
      `! coingecko still rate limited; skipping it for ${Math.round(cooldownMs / 1000)}s`,
    );
    throw new CoinGeckoRateLimitError(
      `rate limited (HTTP 429) — retry in ~${Math.ceil(cooldownMs / 1000)}s, ` +
        `or pass the token's 0x address`,
    );
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

/** Test-only hook (mirrors `__cgTest` in web/src/dapp/cgPrices.ts): clears the
 *  rate-limit cooldown between cases. Not part of the runtime contract. */
export const __cgTest = {
  reset(): void {
    rateLimitedUntil = 0;
  },
  cooldownRemainingMs(): number {
    return Math.max(rateLimitedUntil - Date.now(), 0);
  },
};

export async function resolveToken(
  input: string,
  chain: ChainInfo,
): Promise<Token> {
  if (isAddress(input)) {
    return resolveByAddress(input, chain);
  }

  const upper = input.toUpperCase();
  if (upper === chain.nativeSymbol) {
    // Chains whose gas token is a real ERC20 (Arc: USDC) have no sentinel
    // balance to swap — resolve the symbol to the ERC20 so decimals come
    // from the token (6 on Arc), not from the 18-decimal EVM-level view.
    if (chain.nativeErc20) return resolveByAddress(chain.nativeErc20, chain);
    return {
      address: NATIVE_SENTINEL,
      symbol: chain.nativeSymbol,
      name: chain.nativeSymbol,
      decimals: 18,
      chainId: chain.chainId,
      source: "native",
    };
  }

  return resolveBySymbol(upper, chain);
}

type Resolver = (symbol: string, chain: ChainInfo) => Promise<Token | null>;

async function resolveBySymbol(
  symbol: string,
  chain: ChainInfo,
): Promise<Token> {
  const resolvers: Array<[string, Resolver]> = [
    // Builtin static tables first: for chains with no external index (e.g.
    // Robinhood 4663) this is the only source; for indexed chains the table
    // is empty so this returns null and the network resolvers run unchanged.
    ["builtin", resolveBuiltin],
    ["kyberswap", resolveKyberSwap],
    ["coingecko", resolveCoinGecko],
  ];

  const errors: string[] = [];

  for (const [name, resolver] of resolvers) {
    try {
      const hit = await resolver(symbol, chain);
      if (hit) return hit;
    } catch (err) {
      // Ambiguity is a real signal — surface it, don't swallow.
      if (err instanceof AmbiguousTokenError) throw err;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const detail = errors.length > 0 ? `\n  ${errors.join("\n  ")}` : "";
  // "not found" would be a lie when a source only refused to answer: say so.
  const rateLimited = errors.some((e) => e.includes("rate limited (HTTP 429)"));
  const head = rateLimited
    ? `could not resolve "${symbol}" on ${chain.displayName} — a lookup source is rate limiting.`
    : `token "${symbol}" not found on ${chain.displayName} via any source.`;
  throw new Error(`${head}${detail}\ntry passing its 0x address directly.`);
}

class AmbiguousTokenError extends Error {}

type KyberTokenResponse = {
  data?: {
    tokens?: Array<{
      address: string;
      symbol: string;
      name: string;
      decimals: number;
      chainId: number | string;
    }>;
  };
};

// Static builtin table lookup — no network, no ambiguity (one entry per
// symbol). `symbol` arrives already uppercased; builtinBySymbol matches
// case-insensitively.
const resolveBuiltin: Resolver = async (symbol, chain) => {
  const b = builtinBySymbol(chain.chainId, symbol);
  if (!b) return null;
  return {
    address: b.address.toLowerCase(),
    symbol: b.symbol,
    name: b.name,
    decimals: b.decimals,
    chainId: chain.chainId,
    source: "builtin",
  };
};

const resolveKyberSwap: Resolver = async (symbol, chain) => {
  const url =
    `https://ks-setting.kyberswap.com/api/v1/tokens` +
    `?chainIds=${chain.chainId}` +
    `&query=${encodeURIComponent(symbol)}` +
    `&page=1&pageSize=20&isWhitelisted=true`;

  const data = await fetchJson<KyberTokenResponse>(url);
  const tokens = data.data?.tokens ?? [];
  const exact = tokens.filter(
    (t) =>
      t.symbol.toUpperCase() === symbol &&
      Number(t.chainId) === chain.chainId,
  );

  if (exact.length === 0) return null;

  if (exact.length > 1) {
    const list = exact
      .map((t) => `    ${t.symbol} — ${t.address} (${t.name})`)
      .join("\n");
    throw new AmbiguousTokenError(
      `ambiguous symbol "${symbol}" on ${chain.displayName} (kyberswap). candidates:\n${list}\n` +
        `  pass the 0x address to disambiguate.`,
    );
  }

  const t = exact[0]!;
  return {
    address: t.address.toLowerCase(),
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    chainId: Number(t.chainId),
    source: "kyberswap",
  };
};

type CoinGeckoSearchResponse = {
  coins?: Array<{ id: string; symbol: string; name: string }>;
};

type CoinGeckoCoinResponse = {
  id: string;
  symbol: string;
  name: string;
  platforms?: Record<string, string | null>;
  detail_platforms?: Record<
    string,
    { decimal_place?: number | null; contract_address?: string | null } | null
  >;
};

const resolveCoinGecko: Resolver = async (symbol, chain) => {
  const search = await fetchCoinGecko<CoinGeckoSearchResponse>(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`,
  );

  const candidates = (search.coins ?? []).filter(
    (c) => c.symbol.toUpperCase() === symbol,
  );
  if (candidates.length === 0) return null;

  // Sequential, not parallel — bursting 8 calls hits CoinGecko's
  // free-tier rate limit reliably and trips a cascade of 429s. We
  // also short-circuit on the first match for `chain.coingeckoPlatform`
  // so we don't pay for the full fan-out when the answer is known
  // after the first successful detail, and we abort the whole loop the
  // moment a 429 sticks (see the catch below).
  const details: (CoinGeckoCoinResponse | null)[] = [];
  for (const c of candidates.slice(0, 8)) {
    try {
      const d = await fetchCoinGecko<CoinGeckoCoinResponse>(
        `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(c.id)}` +
          `?localization=false&tickers=false&market_data=false` +
          `&community_data=false&developer_data=false&sparkline=false`,
      );
      details.push(d);
      if (d.platforms?.[chain.coingeckoPlatform]) break;
    } catch (err) {
      // A rate limit is not a per-candidate failure: every remaining candidate
      // would queue behind the same 429 (worst case 8 × retry wait) and the
      // user would end up with a misleading "not found". Stop and surface it.
      if (err instanceof CoinGeckoRateLimitError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`! coingecko detail failed for ${c.id}: ${msg}`);
      details.push(null);
    }
  }

  const onChain = details.flatMap((d) => {
    if (!d) return [];
    const addr = d.platforms?.[chain.coingeckoPlatform];
    if (!addr) return [];
    const detail = d.detail_platforms?.[chain.coingeckoPlatform];
    const decimals =
      typeof detail?.decimal_place === "number" ? detail.decimal_place : null;
    return [{ coin: d, address: addr.toLowerCase(), decimals }];
  });

  if (onChain.length === 0) return null;

  if (onChain.length > 1) {
    const list = onChain
      .map((x) => `    ${x.coin.symbol.toUpperCase()} — ${x.address} (${x.coin.name})`)
      .join("\n");
    throw new AmbiguousTokenError(
      `ambiguous symbol "${symbol}" on ${chain.displayName} (coingecko). candidates:\n${list}\n` +
        `  pass the 0x address to disambiguate.`,
    );
  }

  const hit = onChain[0]!;
  const decimals = await resolveDecimals(chain, hit.address, hit.decimals);
  return {
    address: hit.address,
    symbol: hit.coin.symbol.toUpperCase(),
    name: hit.coin.name,
    decimals,
    chainId: chain.chainId,
    source: hit.decimals === null ? "coingecko+onchain" : "coingecko",
  };
};

export async function resolveAddresses(
  addresses: string[],
  chain: ChainInfo,
): Promise<Map<string, { symbol: string; name: string; decimals: number }>> {
  const out = new Map<
    string,
    { symbol: string; name: string; decimals: number }
  >();
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(
    (a) => ADDRESS_RE.test(a) && a !== NATIVE_SENTINEL,
  );
  if (unique.length === 0) return out;

  // Builtin static table short-circuit — resolve what we can locally and only
  // hit ks-setting for the remainder (on Robinhood that's typically nothing).
  const remaining: string[] = [];
  for (const a of unique) {
    const b = builtinByAddress(chain.chainId, a);
    if (b) out.set(a, { symbol: b.symbol, name: b.name, decimals: b.decimals });
    else remaining.push(a);
  }
  if (remaining.length === 0) return out;

  const url =
    `https://ks-setting.kyberswap.com/api/v1/tokens` +
    `?chainIds=${chain.chainId}` +
    `&addresses=${remaining.join(",")}` +
    `&page=1&pageSize=${remaining.length}`;

  try {
    const data = await fetchJson<KyberTokenResponse>(url);
    for (const t of data.data?.tokens ?? []) {
      out.set(t.address.toLowerCase(), {
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `! intermediate token lookup failed (${remaining.length} addrs): ${msg}`,
    );
  }
  return out;
}

async function resolveByAddress(
  address: string,
  chain: ChainInfo,
): Promise<Token> {
  const lower = address.toLowerCase();

  if (lower === NATIVE_SENTINEL) {
    // No sentinel-native on chains where the gas token is an ERC20 (Arc):
    // the two views of the same balance carry different decimals (18 at the
    // EVM level vs 6 on the token), so silently accepting 0xeee… here would
    // hand every venue an amount scaled by 10^12.
    if (chain.nativeErc20) {
      throw new Error(
        `${chain.displayName} has no separate native token: ${chain.nativeSymbol}'s native ` +
          `balance is exposed through the ERC-20 interface at ${chain.nativeErc20} ` +
          `— pass that address or the symbol ${chain.nativeSymbol}.`,
      );
    }
    return {
      address: NATIVE_SENTINEL,
      symbol: chain.nativeSymbol,
      name: chain.nativeSymbol,
      decimals: 18,
      chainId: chain.chainId,
      source: "native",
    };
  }

  // Builtin static table short-circuit (on-chain-verified metadata) — spares
  // the KyberSwap / CoinGecko round-trips on chains they don't index.
  const builtin = builtinByAddress(chain.chainId, lower);
  if (builtin) {
    return {
      address: lower,
      symbol: builtin.symbol,
      name: builtin.name,
      decimals: builtin.decimals,
      chainId: chain.chainId,
      source: "builtin",
    };
  }

  const url =
    `https://ks-setting.kyberswap.com/api/v1/tokens` +
    `?chainIds=${chain.chainId}` +
    `&query=${lower}` +
    `&page=1&pageSize=5`;

  try {
    const data = await fetchJson<KyberTokenResponse>(url);
    const match = data.data?.tokens?.find(
      (t) => t.address.toLowerCase() === lower,
    );
    if (match) {
      return {
        address: lower,
        symbol: match.symbol,
        name: match.name,
        decimals: match.decimals,
        chainId: Number(match.chainId),
        source: "kyberswap",
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`! kyberswap address lookup failed for ${lower}: ${msg}`);
  }

  try {
    const cg = await fetchCoinGecko<{
      symbol?: string;
      name?: string;
      detail_platforms?: Record<
        string,
        { decimal_place?: number | null } | null
      >;
    }>(
      `https://api.coingecko.com/api/v3/coins/${chain.coingeckoPlatform}` +
        `/contract/${lower}`,
    );
    if (cg.symbol) {
      const dp = cg.detail_platforms?.[chain.coingeckoPlatform]?.decimal_place;
      const offChain = typeof dp === "number" ? dp : null;
      const decimals = await resolveDecimals(chain, lower, offChain);
      return {
        address: lower,
        symbol: cg.symbol.toUpperCase(),
        name: cg.name ?? cg.symbol.toUpperCase(),
        decimals,
        chainId: chain.chainId,
        source: offChain === null ? "coingecko+onchain" : "coingecko",
      };
    }
  } catch (err) {
    // Including CoinGeckoRateLimitError: the address path has an authoritative
    // last resort (on-chain decimals()), so a 429 degrades instead of aborting.
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof CoinGeckoRateLimitError) {
      console.error(
        `! coingecko rate limited for ${lower} (${msg}); falling back to on-chain decimals()`,
      );
    } else {
      console.error(`! coingecko address lookup failed for ${lower}: ${msg}`);
    }
  }

  // Off-chain sources both missed. Last resort: read decimals() on-chain.
  // Never fall back to a guessed 18: a wrong decimals silently rescales the
  // amount by 10^N and corrupts the quote AND the approve/swap calldata.
  const decimals = await resolveDecimals(chain, lower, null);
  return {
    address: lower,
    symbol: `${lower.slice(0, 6)}…${lower.slice(-4)}`,
    name: "unknown token",
    decimals,
    chainId: chain.chainId,
    source: "onchain",
  };
}

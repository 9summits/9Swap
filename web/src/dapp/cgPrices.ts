// cgPrices.ts — USD price resolution (pure logic, NO React imports).
//
// Importable from a standalone bun script as well as the React hook. Prices each
// token of a pair in USD and returns the mid rate (pin / pout). Tokens with a
// CoinGecko id are batched in one `simple/price?ids=…` call; id-less tokens fall
// back to per-contract `token_price`.
//
// CoinGecko is best-effort. A 429, timeout, or network error arms a cooldown
// (no retry — a second hit during a storm just burns the quote render) and the
// same tokens are asked of DefiLlama (`coins.llama.fi/prices/current`, keyless,
// `coingecko:{id}` or `{chain}:{address}`). Failures log one compact line, never
// an Error object (that dumps a stack into the CLI). Stale-on-error still
// serves a positive price ≤10 min old.
//
// Caching is per TOKEN (not per pair) keyed `${chainId}:${addrLower}`:
//   - fresh positive price: served for 5 min;
//   - negative result (fetched OK but no USD price): cached 2 min;
//   - stale-on-error: if a refresh fails and a positive value ≤10 min old exists,
//     it is served rather than dropping the reference rate.
// Concurrent callers for the same token share one in-flight fetch.

import { CG_IDS, CG_PLATFORM } from "./cgIds";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CG_BASE = "https://api.coingecko.com/api/v3";
const LLAMA_BASE = "https://coins.llama.fi/prices/current";

// Cache TTLs (ms).
const FRESH_MS = 5 * 60_000; // positive price is fresh for 5 min
const NEG_MS = 2 * 60_000; //  "no price" result cached for 2 min
// Stale ceiling is deliberately tight: this price feeds the -10% bad-rate
// confirm gate, and a mid asserted from too far back can flip the gate the
// wrong way in a fast market (e.g. ETH ±15% during a prolonged 429 storm).
// 10 min bounds that drift while still riding out realistic rate-limit bursts;
// beyond it we prefer "no reference" (row hidden, gate inert) over a wrong one.
const STALE_MS = 10 * 60_000; // positive price still servable on-error for 10 min
const FETCH_TIMEOUT_MS = 4_000; // hung CoinGecko must not block the quote render
// Circuit breaker: once CoinGecko 429s / times out / 5xxs, stop calling it for
// a while. Later ensurePrices() goes to DefiLlama / stale / null instead of
// paying another wait per token.
const COOLDOWN_MIN_MS = 60_000; // free tier resets per minute
const COOLDOWN_MAX_MS = 5 * 60_000;

// chainId → wrapped-native contract (lowercased), values from src/chains.ts.
// Used only for the token_price fallback of a native token on a chain that has
// no CG_IDS entry (native → wrapped-native contract, same price) — mirrors the
// pre-rework behaviour.
const WRAPPED_NATIVE: Record<number, string> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  10: "0x4200000000000000000000000000000000000006",
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  100: "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
  130: "0x4200000000000000000000000000000000000006",
  137: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
  143: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
  999: "0x5555555555555555555555555555555555555555",
  4663: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  8453: "0x4200000000000000000000000000000000000006",
  9745: "0x6100e367285b01f48d07953803a2d8dca5d19873",
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  43114: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
  57073: "0x4200000000000000000000000000000000000006",
};

// DefiLlama coin-key chain names (not CoinGecko platforms).
const LLAMA_CHAIN: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "gnosis",
  130: "unichain",
  137: "polygon",
  143: "monad",
  999: "hyperliquid",
  4663: "robinhood",
  5042: "arc",
  8453: "base",
  9745: "plasma",
  42161: "arbitrum",
  43114: "avax",
  57073: "ink",
};

type Entry = { usd: number | null; at: number };

// Module-level, per-token caches. Never evicted — the map only ever holds the
// few tokens a user clicks through in a session.
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<number | null>>();

// Epoch ms until which CoinGecko is considered unavailable (0 = not).
let rateLimitedUntil = 0;

let lastWarn = "";
let lastWarnAt = 0;

type Resolved = {
  key: string; // `${chainId}:${addrLower}`
  addr: string; // contract addr for the token_price fallback (native → wrapped)
  cgId: string | null; // CoinGecko coin id, when known
};

function resolveToken(chainId: number, addrLower: string): Resolved {
  const ids = CG_IDS[chainId];
  const cgId =
    addrLower === NATIVE ? (ids?.native ?? null) : (ids?.byAddr[addrLower] ?? null);
  const addr =
    addrLower === NATIVE ? (WRAPPED_NATIVE[chainId] ?? addrLower) : addrLower;
  return { key: `${chainId}:${addrLower}`, addr, cgId };
}

// A cache read that respects freshness: a positive price under FRESH_MS or a
// negative result under NEG_MS is a hit; anything older is a miss (needs fetch).
function freshCached(key: string): { usd: number | null } | null {
  const e = cache.get(key);
  if (!e) return null;
  const age = Date.now() - e.at;
  if (e.usd == null) return age < NEG_MS ? { usd: null } : null;
  return age < FRESH_MS ? { usd: e.usd } : null;
}

// The stale-on-error fallback value: a positive price ≤ STALE_MS old, else null.
// (Ceiling rationale at the STALE_MS definition above.)
function staleValue(key: string): number | null {
  const e = cache.get(key);
  if (!e || e.usd == null) return null;
  return Date.now() - e.at <= STALE_MS ? e.usd : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteUsd(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function positiveUsd(v: unknown): number | null {
  const n = finiteUsd(v);
  return n != null && n > 0 ? n : null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// One compact line; identical messages within 5s are dropped so a 3-token
// batch doesn't print three copies (and never pass an Error — Bun dumps stacks).
function warnOnce(msg: string): void {
  const now = Date.now();
  if (msg === lastWarn && now - lastWarnAt < 5_000) return;
  lastWarn = msg;
  lastWarnAt = now;
  console.warn(msg);
}

// Cooldown length after a persistent CoinGecko failure: at least a minute
// (free-tier reset window), longer if Retry-After says so, never more than 5 min.
function cooldownMs(header: string | null): number {
  const secs = header ? Number(header) : NaN;
  const raw = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 0;
  return Math.min(Math.max(raw, COOLDOWN_MIN_MS), COOLDOWN_MAX_MS);
}

function pauseCoinGecko(ms: number): void {
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + ms);
}

// Fetch CoinGecko once. No retry: DefiLlama is the retry, and sleeping on
// Retry-After used to freeze the CLI mid-quote. 429 / 5xx / timeout / network
// error arm the cooldown so the rest of the run never touches CoinGecko again.
async function cgFetch(url: string): Promise<Response> {
  const remaining = rateLimitedUntil - Date.now();
  if (remaining > 0) {
    throw new Error(`paused ${Math.ceil(remaining / 1000)}s`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    pauseCoinGecko(COOLDOWN_MIN_MS);
    throw new Error(errMsg(e));
  }
  if (res.status === 429) {
    pauseCoinGecko(cooldownMs(res.headers.get("retry-after")));
    throw new Error("HTTP 429");
  }
  if (res.status >= 500) {
    pauseCoinGecko(COOLDOWN_MIN_MS);
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

function readCgIdPrices(body: unknown, ids: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of ids) {
    const row = isRecord(body) ? body[id] : undefined;
    const usd = isRecord(row) ? finiteUsd(row.usd) : null;
    out[id] = usd;
  }
  return out;
}

function readLlamaPrices(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isRecord(body) || !isRecord(body.coins)) return out;
  for (const [key, row] of Object.entries(body.coins)) {
    const usd = isRecord(row) ? positiveUsd(row.price) : null;
    if (usd != null) out.set(key, usd);
  }
  return out;
}

async function llamaFetch(keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const res = await fetch(`${LLAMA_BASE}/${keys.join(",")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return readLlamaPrices(await res.json());
}

// One batched simple/price call, falling back to DefiLlama coingecko:{id}.
async function fetchIdPrices(ids: string[]): Promise<Record<string, number | null>> {
  try {
    const res = await cgFetch(
      `${CG_BASE}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`,
    );
    return readCgIdPrices(await res.json(), ids);
  } catch (e) {
    const why = errMsg(e);
    try {
      const llama = await llamaFetch(ids.map((id) => `coingecko:${id}`));
      const out: Record<string, number | null> = {};
      let any = false;
      for (const id of ids) {
        const p = llama.get(`coingecko:${id}`) ?? null;
        if (p != null) any = true;
        out[id] = p;
      }
      if (any) return out;
    } catch (e2) {
      warnOnce(
        `cgPrices: USD prices unavailable (CoinGecko: ${why}; DefiLlama: ${errMsg(e2)})`,
      );
      throw e;
    }
    warnOnce(`cgPrices: CoinGecko unavailable (${why}); DefiLlama had no prices`);
    throw e;
  }
}

// Per-contract fallback for a token without a known id: CoinGecko token_price,
// then DefiLlama `{chain}:{address}`.
async function fetchContractPrice(
  chainId: number,
  platform: string,
  addr: string,
): Promise<number | null> {
  try {
    const res = await cgFetch(
      `${CG_BASE}/simple/token_price/${platform}?contract_addresses=${addr}&vs_currencies=usd`,
    );
    const j: unknown = await res.json();
    const row = isRecord(j) ? j[addr] : undefined;
    return isRecord(row) ? finiteUsd(row.usd) : null;
  } catch (e) {
    const why = errMsg(e);
    const llamaChain = LLAMA_CHAIN[chainId];
    if (llamaChain) {
      try {
        const llama = await llamaFetch([`${llamaChain}:${addr}`]);
        const p = llama.get(`${llamaChain}:${addr}`) ?? null;
        if (p != null) return p;
      } catch (e2) {
        warnOnce(
          `cgPrices: USD prices unavailable (CoinGecko: ${why}; DefiLlama: ${errMsg(e2)})`,
        );
        throw e;
      }
    }
    warnOnce(`cgPrices: CoinGecko unavailable (${why}); DefiLlama had no prices`);
    throw e;
  }
}

// Store a fetched price (positive or negative) and return it.
function commit(key: string, usd: number | null): number | null {
  cache.set(key, { usd, at: Date.now() });
  return usd;
}

// After a failed refresh: serve a ≤10-min-old positive value, else cache a
// negative so we don't re-hit DefiLlama on every quote refresh.
function onError(key: string): number | null {
  const s = staleValue(key);
  if (s != null) {
    warnOnce("cgPrices: serving stale (≤10m) prices");
    return s;
  }
  return commit(key, null);
}

// Ensure a USD price for each token, sharing one batched fetch for id-tokens and
// deduping concurrent in-flight fetches per token key.
async function ensurePrices(
  chainId: number,
  tokens: Resolved[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const waits: Promise<void>[] = [];
  const toFetch: Resolved[] = [];

  for (const t of tokens) {
    const hit = freshCached(t.key);
    if (hit) {
      result.set(t.key, hit.usd);
      continue;
    }
    const inf = inflight.get(t.key);
    if (inf) {
      waits.push(inf.then((v) => void result.set(t.key, v)));
      continue;
    }
    toFetch.push(t);
  }

  const idTokens = toFetch.filter((t) => t.cgId);
  const contractTokens = toFetch.filter((t) => !t.cgId);
  const register = (key: string, p: Promise<number | null>) => {
    inflight.set(key, p);
    void p.finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    waits.push(p.then((v) => void result.set(key, v)));
  };

  // id-tokens: one batched simple/price call, shared by every id-token this round.
  if (idTokens.length) {
    const ids = [...new Set(idTokens.map((t) => t.cgId!))];
    const batch = fetchIdPrices(ids);
    for (const t of idTokens) {
      register(
        t.key,
        batch.then(
          (map) => {
            const v = map[t.cgId!] ?? null;
            if (v != null) return commit(t.key, v);
            const s = staleValue(t.key);
            if (s != null) return s;
            return commit(t.key, null);
          },
          () => onError(t.key),
        ),
      );
    }
  }

  // contract-fallback tokens: one token_price call each.
  const platform = CG_PLATFORM[chainId];
  for (const t of contractTokens) {
    register(
      t.key,
      (async () => {
        if (!platform) {
          warnOnce(
            `cgPrices: no CoinGecko platform for chain ${chainId}; cannot price ${t.key}`,
          );
          return null;
        }
        try {
          return commit(t.key, await fetchContractPrice(chainId, platform, t.addr));
        } catch {
          return onError(t.key);
        }
      })(),
    );
  }

  await Promise.all(waits);
  return result;
}

// Resolve both sides' USD price and return the mid rate (tokenOut per tokenIn):
// pin / pout, or null while either side is unknown or pout ≤ 0. Addresses must be
// lowercased by the caller; the native sentinel is handled here.
export async function fetchUsdPrices(
  chainId: number,
  addrsLower: string[],
): Promise<Map<string, number | null>> {
  const resolved = addrsLower.map((input) => ({
    input,
    r: resolveToken(chainId, input.toLowerCase()),
  }));
  const unique = new Map<string, Resolved>();
  for (const x of resolved) unique.set(x.r.key, x.r);
  const prices = await ensurePrices(chainId, [...unique.values()]);
  const out = new Map<string, number | null>();
  for (const x of resolved) {
    out.set(x.input, prices.get(x.r.key) ?? null);
  }
  return out;
}

export async function fetchPairRate(
  chainId: number,
  inAddrLower: string,
  outAddrLower: string,
): Promise<number | null> {
  const a = resolveToken(chainId, inAddrLower);
  const b = resolveToken(chainId, outAddrLower);
  const prices = await ensurePrices(chainId, [a, b]);
  const pin = prices.get(a.key) ?? null;
  const pout = prices.get(b.key) ?? null;
  return pin != null && pout != null && pout > 0 ? pin / pout : null;
}

// Test-only hooks. Not part of the runtime contract; used by tests/cgPrices.test.ts
// to seed cache state (stale/negative) and reset between cases.
export const __cgTest = {
  resolveToken,
  cache,
  inflight,
  reset(): void {
    cache.clear();
    inflight.clear();
    rateLimitedUntil = 0;
    lastWarn = "";
    lastWarnAt = 0;
  },
  cooldownRemainingMs(): number {
    return Math.max(rateLimitedUntil - Date.now(), 0);
  },
  seed(key: string, usd: number | null, ageMs: number): void {
    cache.set(key, { usd, at: Date.now() - ageMs });
  },
};

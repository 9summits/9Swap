// cgPrices.ts — CoinGecko USD price resolution (pure logic, NO React imports).
//
// Importable from a standalone bun script as well as the React hook. Prices each
// token of a pair in USD and returns the mid rate (pin / pout). The point of the
// rework: resolve tokens through the generated CG_IDS table so BOTH sides can be
// priced in ONE batched `simple/price?ids=…` call instead of two per-contract
// `token_price` lookups (the free tier caps token_price at one contract per
// request and rate-limits it hard). Tokens without an id fall back to the
// per-contract token_price lookup, exactly like before.
//
// Caching is per TOKEN (not per pair) keyed `${chainId}:${addrLower}`, so a token
// priced for one pair is reused across every other pair it appears in:
//   - fresh positive price: served for 5 min;
//   - negative result (fetched OK but CoinGecko had no USD price): cached 2 min;
//   - stale-on-error: if a refresh fails and a positive value ≤10 min old exists,
//     it is served (and logged) rather than dropping the reference rate.
// Concurrent callers for the same token share one in-flight fetch. Every failure
// path is logged (console.warn) — no silent catches.

import { CG_IDS, CG_PLATFORM } from "./cgIds";

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CG_BASE = "https://api.coingecko.com/api/v3";

// Cache TTLs (ms).
const FRESH_MS = 5 * 60_000; // positive price is fresh for 5 min
const NEG_MS = 2 * 60_000; //  "no price" result cached for 2 min
// Stale ceiling is deliberately tight: this price feeds the -10% bad-rate
// confirm gate, and a mid asserted from too far back can flip the gate the
// wrong way in a fast market (e.g. ETH ±15% during a prolonged 429 storm).
// 10 min bounds that drift while still riding out realistic rate-limit bursts;
// beyond it we prefer "no reference" (row hidden, gate inert) over a wrong one.
const STALE_MS = 10 * 60_000; // positive price still servable on-error for 10 min
const RETRY_AFTER_CAP_MS = 30_000; // honor Retry-After up to 30s
const RETRY_AFTER_DEFAULT_MS = 1500; // 429 with no/garbage Retry-After
// Circuit breaker: once a 429 survives the retry, stop calling CoinGecko for a
// while. During a 429 storm every later ensurePrices() then goes straight to
// stale-on-error / null instead of paying another retry wait per token.
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

type Entry = { usd: number | null; at: number };

// Module-level, per-token caches. Never evicted — the map only ever holds the
// few tokens a user clicks through in a session.
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<number | null>>();

// Epoch ms until which CoinGecko is considered rate-limited (0 = not).
let rateLimitedUntil = 0;

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(header: string | null): number {
  if (!header) return RETRY_AFTER_DEFAULT_MS;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  }
  const when = Date.parse(header); // HTTP-date form
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(when - Date.now(), 0), RETRY_AFTER_CAP_MS);
  }
  return RETRY_AFTER_DEFAULT_MS;
}

// Cooldown length after a persistent 429: at least a minute (free-tier reset
// window), longer if Retry-After says so, never more than 5 min.
function cooldownMs(header: string | null): number {
  const secs = header ? Number(header) : NaN;
  const raw = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 0;
  return Math.min(Math.max(raw, COOLDOWN_MIN_MS), COOLDOWN_MAX_MS);
}

// Fetch with one 429 retry honoring Retry-After (capped). Throws on any non-OK
// response (including a still-429 after the retry) so callers apply stale-on-error.
// A surviving 429 also arms a cooldown: while it holds, calls throw immediately
// without touching the network.
async function cgFetch(url: string): Promise<Response> {
  const remaining = rateLimitedUntil - Date.now();
  if (remaining > 0) {
    throw new Error(
      `cgPrices: rate limited, backing off ${Math.ceil(remaining / 1000)}s more`,
    );
  }
  let res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429) {
    const wait = retryAfterMs(res.headers.get("retry-after"));
    console.warn(`cgPrices: 429 on ${url}; retrying once in ${wait}ms`);
    await sleep(wait);
    res = await fetch(url, { headers: { accept: "application/json" } });
  }
  if (res.status === 429) {
    const cool = cooldownMs(res.headers.get("retry-after"));
    rateLimitedUntil = Date.now() + cool;
    console.warn(`cgPrices: still 429 after retry; pausing CoinGecko for ${cool}ms`);
  }
  if (!res.ok) throw new Error(`cgPrices: HTTP ${res.status} on ${url}`);
  return res;
}

// One batched simple/price call for a set of coin ids → { id: usd|null }.
async function fetchIdPrices(ids: string[]): Promise<Record<string, number | null>> {
  const res = await cgFetch(
    `${CG_BASE}/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`,
  );
  const j = (await res.json()) as Record<string, { usd?: number }>;
  const out: Record<string, number | null> = {};
  for (const id of ids) out[id] = j[id]?.usd ?? null;
  return out;
}

// The per-contract fallback for a token without a known id.
async function fetchContractPrice(
  platform: string,
  addr: string,
): Promise<number | null> {
  const res = await cgFetch(
    `${CG_BASE}/simple/token_price/${platform}?contract_addresses=${addr}&vs_currencies=usd`,
  );
  const j = (await res.json()) as Record<string, { usd?: number }>;
  return j[addr]?.usd ?? null;
}

// Store a fetched price (positive or negative) and return it.
function commit(key: string, usd: number | null): number | null {
  cache.set(key, { usd, at: Date.now() });
  return usd;
}

// Apply stale-on-error after a failed refresh: serve a ≤10-min-old positive
// value (logged), else null.
function onError(key: string, label: string, e: unknown): number | null {
  console.warn(`cgPrices: ${label} failed for ${key}`, e);
  const s = staleValue(key);
  if (s != null) {
    console.warn(`cgPrices: serving stale (≤10m) price for ${key}`);
    return s;
  }
  return null;
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
          (map) => commit(t.key, map[t.cgId!] ?? null),
          (e) => onError(t.key, "id batch", e),
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
          console.warn(
            `cgPrices: no CoinGecko platform for chain ${chainId}; cannot price ${t.key}`,
          );
          return null;
        }
        try {
          return commit(t.key, await fetchContractPrice(platform, t.addr));
        } catch (e) {
          return onError(t.key, "token_price", e);
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
  },
  cooldownRemainingMs(): number {
    return Math.max(rateLimitedUntil - Date.now(), 0);
  },
  seed(key: string, usd: number | null, ageMs: number): void {
    cache.set(key, { usd, at: Date.now() - ageMs });
  },
};

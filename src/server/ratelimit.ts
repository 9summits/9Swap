// Application-level rate limiting for the public /api/* surface (Vercel only).
//
// Why it exists: the deployment has no session gate, so any visitor can burn
// the venue API keys' quotas (1inch, 0x, Odos, Uniswap, OpenOcean). This bounds
// a single abusive client per instance.
//
// ponytail: per-instance counters, upgrade to Vercel WAF or Upstash if real
// abuse shows up. Serverless spreads traffic over N instances and cold starts
// wipe the map, so the true ceiling is (limit × live instances) — enough to
// stop one hammering client, not a distributed one. The Vercel WAF (dashboard,
// not code) remains the real edge layer.
//
// No Bun.* here: this module is imported by api/*.ts, which Vercel compiles
// for Node (same constraint as src/server/shared.ts).

/** Endpoint classes, sized by cost: venue quotes > builds > submits > static. */
export type Bucket = "quote" | "build" | "submit" | "light";

// Requests per minute, per IP, per bucket. Calibrated against the dApp's real
// cadence (web/src/dapp/useQuote.ts): inputs are debounced 400ms and a round
// fires one /api/quote/stream + one /api/route, then auto-refreshes on quote
// expiry (~20s). A busy tab sits around 10-20 quote-class calls/min; 60 leaves
// headroom for fast typing and venue switching. build/submit are click-driven.
const LIMITS: Record<Bucket, number> = {
  quote: 60,
  build: 12,
  submit: 6,
  light: 120,
};

const WINDOW_MS = 60_000;
/** Entries untouched for this long are dropped so the map can't grow forever. */
const IDLE_MS = 5 * WINDOW_MS;

type Entry = { tokens: number; last: number };

const entries = new Map<string, Entry>();
let lastPurge = 0;

/**
 * Caller IP as seen behind Vercel's proxy: first hop of `x-forwarded-for`,
 * else `x-real-ip`, else "unknown" (all such callers then share one bucket).
 */
export function clientIp(req: Request): string {
  const first = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function purge(now: number): void {
  if (now - lastPurge < WINDOW_MS) return;
  lastPurge = now;
  for (const [k, e] of entries) {
    if (now - e.last > IDLE_MS) entries.delete(k);
  }
}

/**
 * Token bucket: capacity = the per-minute limit, refilled continuously at
 * limit/WINDOW_MS. Returns null when the request is allowed, or the number of
 * seconds to wait (>= 1) when it is refused.
 */
export function take(ip: string, bucket: Bucket, now = Date.now()): number | null {
  purge(now);
  const cap = LIMITS[bucket];
  const key = `${bucket}:${ip}`;
  const e = entries.get(key) ?? { tokens: cap, last: now };
  e.tokens = Math.min(cap, e.tokens + ((now - e.last) * cap) / WINDOW_MS);
  e.last = now;
  entries.set(key, e);
  if (e.tokens < 1) {
    return Math.max(1, Math.ceil(((1 - e.tokens) * WINDOW_MS) / cap / 1000));
  }
  e.tokens -= 1;
  return null;
}

/**
 * Guard for the Vercel wrappers: `return rateLimit(req, "quote") ?? handler(req)`.
 * Returns a 429 Response to short-circuit, or null to proceed.
 *
 * Off Vercel it is a no-op: the local Bun server (src/serve.ts) and the
 * `--browser` bridge run the same handlers for a single trusted user and must
 * stay unthrottled.
 */
export function rateLimit(req: Request, bucket: Bucket): Response | null {
  if (!process.env.VERCEL) return null;
  const ip = clientIp(req);
  const retryAfter = take(ip, bucket);
  if (retryAfter == null) return null;
  let path = req.url;
  try {
    path = new URL(req.url).pathname;
  } catch (e) {
    // Never fail the guard on a malformed URL — log and keep the raw string.
    console.warn(`rate limit: unparseable request url ${req.url}: ${(e as Error).message}`);
  }
  console.warn(`rate limited: ${ip} on ${path} (${bucket}, ${LIMITS[bucket]}/min)`);
  return Response.json(
    { error: "rate limited, retry shortly" },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

// Self-test: `bun run src/server/ratelimit.ts`.
if (import.meta.main) {
  const ok = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  const t0 = 1_000_000;

  // A fresh IP spends exactly `cap` tokens, then is refused.
  for (let i = 0; i < LIMITS.build; i++) {
    ok(take("1.1.1.1", "build", t0) === null, `build call ${i + 1} should pass`);
  }
  const refused = take("1.1.1.1", "build", t0);
  ok(refused !== null && refused >= 1, "build call 13 should be refused with a retry delay");

  // Buckets are independent per class and per IP.
  ok(take("1.1.1.1", "quote", t0) === null, "quote bucket must be independent of build");
  ok(take("2.2.2.2", "build", t0) === null, "another IP must have its own bucket");

  // Refill: a full window later the bucket is back to capacity.
  ok(take("1.1.1.1", "build", t0 + WINDOW_MS) === null, "refill after one window");

  // Partial refill: cap/2 worth of time buys about cap/2 calls, not more.
  const t1 = t0 + 10 * WINDOW_MS;
  for (let i = 0; i < LIMITS.submit; i++) take("3.3.3.3", "submit", t1);
  ok(take("3.3.3.3", "submit", t1) !== null, "submit bucket drained at t1");
  const half = WINDOW_MS / 2;
  for (let i = 0; i < LIMITS.submit / 2; i++) {
    ok(take("3.3.3.3", "submit", t1 + half) === null, "half a window refills half the bucket");
  }
  ok(take("3.3.3.3", "submit", t1 + half) !== null, "…and no more than half");

  // IP extraction: first x-forwarded-for hop wins, then x-real-ip, then unknown.
  const withHeaders = (h: Record<string, string>) =>
    clientIp(new Request("https://x.invalid/api/quote", { headers: h }));
  ok(withHeaders({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }) === "9.9.9.9", "xff first hop");
  ok(withHeaders({ "x-forwarded-for": "  8.8.8.8  " }) === "8.8.8.8", "xff trimmed");
  ok(withHeaders({ "x-real-ip": "7.7.7.7" }) === "7.7.7.7", "x-real-ip fallback");
  ok(withHeaders({}) === "unknown", "unknown fallback");

  // Purge drops idle entries instead of leaking them.
  take("4.4.4.4", "light", t1);
  ok(entries.size > 1, "several entries live before the purge");
  take("5.5.5.5", "light", t1 + IDLE_MS + WINDOW_MS + 1);
  ok(entries.size === 1, `idle entries must be purged (size ${entries.size})`);

  // Guard wiring, on real `Date.now()` so the drain below is what rateLimit sees.
  const req = new Request("https://x.invalid/api/submit", {
    headers: { "x-forwarded-for": "6.6.6.6" },
  });
  for (let i = 0; i < LIMITS.submit; i++) take("6.6.6.6", "submit");
  delete process.env.VERCEL;
  ok(rateLimit(req, "submit") === null, "guard must be inert without VERCEL");
  process.env.VERCEL = "1";
  const res = rateLimit(req, "submit");
  ok(res?.status === 429, "guard must 429 on Vercel once drained");
  ok(res?.headers.get("retry-after") != null, "429 must carry Retry-After");
  ok((await res!.json()).error === "rate limited, retry shortly", "429 body shape");
  delete process.env.VERCEL;

  console.log("ratelimit self-test ok");
}

// Human-readable reasons for the Venues pane's "N venues unavailable" list.
//
// The server streams raw adapter errors as `verror` events, and adapters phrase
// them for the CLI (which prints them verbatim, and should): they carry a venue
// prefix, sometimes a stage word, sometimes an HTTP status, and only then the
// part a user cares about:
//
//   matcha: no liquidity for this pair
//   velora 400 Bad Request — ESTIMATED_LOSS_GREATER_THAN_MAX_IMPACT
//   delta: Max price impact reached. Impact: 78.16%
//   kyberswap error: code 4008
//   odos Insufficient liquidity to swap
//   <venue> requires an API key — set X (free at …)
//
// The dApp used to keep the first clause (split on the first "—" / ":" / "-"),
// which is exactly the venue prefix — the one word the row already shows in its
// own label. Here we strip that prefix instead (venue id / label / alias +
// optional stage word + optional HTTP status + separator), never cutting on an
// inner "-" or ":", and map the remainder onto a short English label. Anything
// unrecognized degrades to the stripped message, so a new adapter error is
// still readable. The raw string stays available in the row's `title`.
//
// Pure module (no React): runnable as a self-check with
// `bun run web/src/dapp/venueReason.ts`.

import { VENUE } from "./venues";

// Venue-id → prefixes seen in adapter messages that differ from the dApp's
// venue id (the id and the display label are always candidates too).
const ALIASES: Record<string, string[]> = {
  kyber: ["kyberswap"],
  matcha: ["0x", "zeroex"],
  velora: ["paraswap"],
  delta: ["velora delta", "paraswap delta"],
  "1inch": ["oneinch"],
  fusion: ["1inch fusion", "fusion+"],
  cow: ["cowswap", "cow protocol"],
  uniswapx: ["uniswap x"],
  odosv2: ["odos v2", "odos"],
};

// Stage words adapters insert between the venue and the message.
const STAGE_RE = /^[ \t]+(?:build|quote|assemble|error|buildOrder|eth-flow|buy|sell)\b/i;
// ": " / " — " / " - " between the prefix (or the status) and the message.
const SEP_RE = /^(?:[ \t]*[:—–][ \t]*|[ \t]+-[ \t]+)/;
// "<status> <statusText>", the statusText running up to a separator or the end.
const STATUS_RE = /^[ \t]*(\d{3})(?:[ \t]+([A-Za-z][A-Za-z ]*?))?(?=[ \t]*(?:[:—–]|$))/;

const MAX_LEN = 90;

export function humanVenueReason(venue: string, reason: string): string {
  const raw = (reason ?? "").trim();
  if (!raw) return "unavailable";

  const { status, statusText, rest } = stripVenuePrefix(venue, raw);

  if (status !== null) {
    if (status === 429) return "rate-limited, retry later";
    const mapped = classify(rest);
    if (mapped) return mapped;
    if (meaningful(rest)) return tidy(rest);
    return status >= 500
      ? `venue API error (${status})`
      : `venue API error (${statusText ? `${status} ${statusText}` : status})`;
  }

  return classify(rest) ?? tidy(rest || raw);
}

// ---- prefix stripping ------------------------------------------------------

type Stripped = { status: number | null; statusText: string | null; rest: string };

function stripVenuePrefix(venue: string, reason: string): Stripped {
  let s = reason;
  const p = matchPrefix(venue, s);
  if (p === null) return { status: null, statusText: null, rest: s };
  s = s.slice(p);

  const stage = STAGE_RE.exec(s);
  if (stage) s = s.slice(stage[0].length);

  const sep1 = SEP_RE.exec(s);
  if (sep1) s = s.slice(sep1[0].length);

  let status: number | null = null;
  let statusText: string | null = null;
  const st = STATUS_RE.exec(s);
  if (st) {
    status = Number(st[1]);
    statusText = st[2] ? st[2].trim() : null;
    s = s.slice(st[0].length);
    const sep2 = SEP_RE.exec(s);
    if (sep2) s = s.slice(sep2[0].length);
  }

  return { status, statusText, rest: s.trim() };
}

// Length of the venue prefix at the head of `reason`, or null when the message
// doesn't start with one. Longest candidate wins (odosv2 before odos, uniswapx
// before uniswap) and the prefix must end on a boundary so "0x" never eats the
// head of an address.
function matchPrefix(venue: string, reason: string): number | null {
  const low = reason.toLowerCase();
  for (const cand of prefixCandidates(venue)) {
    if (!low.startsWith(cand)) continue;
    const next = reason[cand.length];
    if (next === undefined || next === " " || next === "\t" || next === ":" || next === "—" || next === "–")
      return cand.length;
  }
  return null;
}

function prefixCandidates(venue: string): string[] {
  const v = venue.toLowerCase();
  const out = new Set<string>([v]);
  const label = VENUE[v]?.label.toLowerCase();
  if (label) {
    out.add(label);
    // "0x · Matcha" / "CoW Swap" → each half is a plausible prefix too.
    for (const part of label.split("·")) {
      const trimmed = part.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  for (const a of ALIASES[v] ?? []) out.add(a);
  return [...out].sort((a, b) => b.length - a.length);
}

// ---- message → label -------------------------------------------------------

function classify(msg: string): string | null {
  const m = msg.toLowerCase();
  if (!m) return null;
  if (m.includes("native eth") || m.includes("native token") || m.includes("wrap to"))
    return "native input — wrap to WETH first";
  // NB: no bare "missing" match — "missing dstAmount in response" is not an
  // API-key problem.
  if (m.includes("api key") || m.includes("api-key")) return "needs an API key";
  if (m.includes("does not support") || m.includes("unsupported"))
    return "unsupported for this pair";
  if (
    m.includes("consume this service") ||
    /\b429\b/.test(m) ||
    m.includes("rate limit") ||
    m.includes("too many requests")
  )
    return "rate-limited, retry later";
  if (m.includes("no liquidity") || m.includes("no route") || m.includes("insufficient liquidity"))
    return "no liquidity for this pair";
  if (
    m.includes("estimated_loss_greater_than_max_impact") ||
    m.includes("price impact") ||
    m.includes("max impact")
  ) {
    const pct = msg.match(/(\d+(?:\.\d+)?)\s*%/);
    return pct ? `price impact too high (${pct[1]}%)` : "price impact too high";
  }
  if (m.includes("timeout") || m.includes("timed out") || m.includes("abort"))
    return "timed out";
  return null;
}

// An HTTP error's trailing text is only worth showing when it carries words.
function meaningful(rest: string): boolean {
  return rest.length >= 3 && /[a-z0-9]/i.test(rest);
}

// Unmapped messages: first sentence, single-spaced, no trailing period, capped.
function tidy(msg: string): string {
  let s = firstSentence(msg).replace(/\s+/g, " ").trim();
  s = s.replace(/[.\s]+$/, "");
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN - 1).trimEnd() + "…";
  return s || "unavailable";
}

function firstSentence(msg: string): string {
  const m = msg.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return m ? m[0] : msg;
}

// ---- self-check: the real message shapes from src/venues/* -----------------
// Run: `bun run web/src/dapp/venueReason.ts`
if (import.meta.main) {
  const eq = (venue: string, reason: string, want: string) => {
    const got = humanVenueReason(venue, reason);
    if (got !== want)
      throw new Error(`${venue} / ${reason}\n  got:  ${got}\n  want: ${want}`);
  };

  // The three shapes that used to collapse to the venue name.
  eq("matcha", "matcha: no liquidity for this pair", "no liquidity for this pair");
  eq(
    "velora",
    "velora 400 Bad Request — ESTIMATED_LOSS_GREATER_THAN_MAX_IMPACT",
    "price impact too high",
  );
  eq(
    "delta",
    "delta: Max price impact reached. Impact: 78.16%",
    "price impact too high (78.16%)",
  );

  // MissingApiKeyError / UnsupportedSideError / native rejection.
  eq(
    "matcha",
    "matcha requires an API key — set ZEROEX_API_KEY (free at https://dashboard.0x.org)",
    "needs an API key",
  );
  eq(
    "cow",
    "cow does not support exact-out (sell-only); buy-capable venues: kyber, velora, matcha",
    "unsupported for this pair",
  );
  eq(
    "fusion",
    "fusion does not support native ETH as tokenIn — wrap to WETH (or the chain's wrapped native) and pass that address.",
    "native input — wrap to WETH first",
  );

  // Rate limit (message shape and status shape), timeout, 5xx with no message.
  eq("1inch", "1inch: Your account cannot consume this service", "rate-limited, retry later");
  eq("odos", "odos 429 Too Many Requests", "rate-limited, retry later");
  eq("kyber", "kyber: timeout after 15s", "timed out");
  eq("openocean", "openocean: 503 Service Unavailable", "venue API error (503)");
  eq("velora", "velora 400 Bad Request", "venue API error (400 Bad Request)");

  // Prefix shapes: `<venue> error:` under a different dApp id, and no colon.
  eq("kyber", "kyberswap error: code 4008", "code 4008");
  eq("odos", "odos Insufficient liquidity to swap", "no liquidity for this pair");

  // Non-regression: "missing …" is not an API-key problem, and an inner "—"
  // or ":" no longer truncates the message.
  eq("1inch", "1inch: missing dstAmount in response", "missing dstAmount in response");
  eq(
    "velora",
    "velora: cannot build tx — quote.raw missing priceRoute",
    "cannot build tx — quote.raw missing priceRoute",
  );

  // Dispatcher messages carry no venue prefix; digits inside an amount must not
  // read as an HTTP 429.
  eq(
    "kyber",
    "sell refine below exact-out target (1429 < 2000)",
    "sell refine below exact-out target (1429 < 2000)",
  );

  // Long unmapped message → first sentence, capped.
  const long = humanVenueReason(
    "odos",
    "odos Odos discontinued its app and API on 2026-07-30 — venue disabled (adapter kept for reference, see the changelog)",
  );
  if (long.length > MAX_LEN) throw new Error(`fallback not capped: ${long.length}`);
  if (!long.endsWith("…")) throw new Error(`fallback not ellipsized: ${long}`);
  if (long.startsWith("odos ")) throw new Error(`prefix not stripped: ${long}`);

  console.log("venueReason self-check: OK");
}

// URL ↔ swap-state sync for the dApp. The shareable swap state — chain, token
// pair, amount, venue filter, slippage — lives in the query string so a link
// restores it. Any other params (notably the session `id`) are preserved.
//
// Wire format (all optional):
//   chain=<alias>  in=<address>  out=<address>  amount=<human>
//   venues=<csv>   (absent ⇒ "all venues")
//   slippage=<percent>   (0.1 = 10 bps; state is bps, the URL is human percent)
//
// The pure core (parseUrlState / applyUrlState) is testable without a DOM; the
// browser glue (readUrlState / writeUrlState) touches location/history.

export type UrlSwapState = {
  chain: string | null;
  tokenIn: string | null; // address
  tokenOut: string | null; // address
  amount: string | null; // human units
  venues: string[] | null; // null = param absent = "all"
  slippageBps: number | null;
};

export type UrlWriteState = {
  chain: string | null;
  tokenIn: string | null;
  tokenOut: string | null;
  amount: string | null;
  venues: string[] | null; // null/empty ⇒ omit (the "all" default)
  slippageBps: number | null;
};

// ---- pure core -------------------------------------------------------------

export function parseUrlState(search: string): UrlSwapState {
  const p = new URLSearchParams(search);
  const venuesRaw = p.get("venues");
  const slipRaw = p.get("slippage");
  const slipPct = slipRaw == null ? NaN : Number(slipRaw);
  return {
    chain: p.get("chain"),
    tokenIn: p.get("in"),
    tokenOut: p.get("out"),
    amount: p.get("amount"),
    venues:
      venuesRaw == null
        ? null
        : venuesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    slippageBps:
      Number.isFinite(slipPct) && slipPct >= 0 ? Math.round(slipPct * 100) : null,
  };
}

// Apply the swap state onto an existing params set (mutates a copy), returning
// the new query string (no leading "?"). Keys we don't own are left untouched.
export function applyUrlState(
  params: URLSearchParams,
  s: UrlWriteState,
): string {
  const q = new URLSearchParams(params);
  const set = (k: string, v: string | null) => {
    if (v == null || v === "") q.delete(k);
    else q.set(k, v);
  };
  set("chain", s.chain);
  set("in", s.tokenIn);
  set("out", s.tokenOut);
  set("amount", s.amount);
  set("venues", s.venues && s.venues.length ? s.venues.join(",") : null);
  set("slippage", s.slippageBps != null ? String(s.slippageBps / 100) : null);
  return q.toString();
}

// ---- browser glue ----------------------------------------------------------

export function readUrlState(): UrlSwapState {
  return parseUrlState(typeof location === "undefined" ? "" : location.search);
}

export function writeUrlState(s: UrlWriteState): void {
  const url = new URL(location.href);
  const query = applyUrlState(url.searchParams, s);
  const next = `${url.pathname}${query ? "?" + query : ""}${url.hash}`;
  const cur = `${location.pathname}${location.search}${location.hash}`;
  if (next !== cur) history.replaceState(null, "", next);
}

// ---- self-check: round-trip + id preservation + "all" omit -----------------
// Run: `bun run web/src/dapp/urlState.ts`
if (import.meta.main) {
  const q = applyUrlState(new URLSearchParams("id=abc123"), {
    chain: "eth",
    tokenIn: "0xAAA",
    tokenOut: "0xBBB",
    amount: "10000",
    venues: ["cow", "ophis"],
    slippageBps: 35,
  });
  if (!q.includes("id=abc123")) throw new Error("id param not preserved");
  const back = parseUrlState("?" + q);
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  };
  eq(back.chain, "eth", "chain");
  eq(back.tokenIn, "0xAAA", "tokenIn");
  eq(back.tokenOut, "0xBBB", "tokenOut");
  eq(back.amount, "10000", "amount");
  eq(back.venues, ["cow", "ophis"], "venues");
  eq(back.slippageBps, 35, "slippageBps"); // 0.35% → 35 bps

  // all-on ⇒ venues omitted; empty amount omitted
  const q2 = applyUrlState(new URLSearchParams(), {
    chain: "base",
    tokenIn: null,
    tokenOut: null,
    amount: "",
    venues: null,
    slippageBps: 10,
  });
  if (parseUrlState("?" + q2).venues !== null) throw new Error("venues should be omitted");
  if (q2.includes("amount=")) throw new Error("empty amount should be omitted");
  eq(parseUrlState("?" + q2).slippageBps, 10, "slippage 0.1%→10bps");
  console.log("urlState self-check: OK");
}

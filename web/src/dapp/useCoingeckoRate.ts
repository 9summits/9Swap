import { useEffect, useState } from "react";
import type { ChainMeta, TokenInfo } from "./types";
import { fetchPairRate } from "./cgPrices";

// Mid-market reference rate (tokenOut per tokenIn) from CoinGecko, to sanity-check
// the swap quote against. Thin wrapper over fetchPairRate (cgPrices.ts) — all the
// resolution, per-token caching, batching, 429 handling and stale-on-error live
// there. Returns null while loading or on any failure (the caller hides the row),
// null for a same-token pair, and re-evaluates whenever the chain or either token
// address changes.
export function useCoingeckoRate(
  chain: ChainMeta,
  tokenIn: TokenInfo | null,
  tokenOut: TokenInfo | null,
): number | null {
  const [rate, setRate] = useState<number | null>(null);
  const chainId = chain.chainId;

  const inAddr = tokenIn ? tokenIn.address.toLowerCase() : null;
  const outAddr = tokenOut ? tokenOut.address.toLowerCase() : null;
  const same = inAddr != null && inAddr === outAddr;
  // NATIVE and wrapped-native are distinct addresses here; the same-token guard
  // only collapses a literally identical pair (as before).
  const active = inAddr != null && outAddr != null && !same;

  useEffect(() => {
    setRate(null);
    if (!active || inAddr == null || outAddr == null) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetchPairRate(chainId, inAddr, outAddr);
        if (alive) setRate(r);
      } catch (e) {
        // fetchPairRate is defensive and shouldn't throw, but never swallow.
        console.warn("useCoingeckoRate: fetchPairRate failed", e);
        if (alive) setRate(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chainId, inAddr, outAddr, active]);

  return rate;
}

// Text/USD-display color for how far the swap rate sits below the CoinGecko mid:
// ≥ -0.1% green · -0.1..-0.3% orange · -0.3..-2% red · < -2% bright red.
export function cgDiffColor(pct: number): string {
  if (pct >= -0.1) return "var(--positive)";
  if (pct >= -0.3) return "var(--warning)";
  if (pct >= -2) return "var(--negative)";
  return "#ff1744";
}

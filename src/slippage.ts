/**
 * Shared slippage math for exact-in floors / exact-out ceilings.
 * Used by allowance ceilings (CLI + handlers) and signed order amounts (cow/ophis).
 * bps are clamped to [0, 10_000] and truncated (matches orderbook adapters).
 */

function clampBps(slippageBps: number): number {
  if (!Number.isFinite(slippageBps)) return 0;
  return Math.max(0, Math.min(10_000, Math.trunc(slippageBps)));
}

/**
 * Sell-side (exact-in) floor: min acceptable amountOut after slippage.
 * minOut = amountOut * (10_000 - bps) / 10_000  (integer, floors).
 */
export function minAmountOut(amountOut: bigint, slippageBps: number): bigint {
  const bps = clampBps(slippageBps);
  if (bps <= 0) return amountOut;
  if (bps >= 10_000) return 0n;
  return (amountOut * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Buy-side (exact-out) ceiling: max acceptable amountIn after slippage.
 * maxIn = amountIn * (10_000 + bps) / 10_000  (integer, floors).
 */
export function maxAmountIn(amountIn: bigint, slippageBps: number): bigint {
  const bps = clampBps(slippageBps);
  if (bps <= 0) return amountIn;
  return (amountIn * BigInt(10_000 + bps)) / 10_000n;
}

/**
 * Cap sell-side slippage so `minAmountOut(quotedOut, bps) >= minOutFloor`.
 *
 * Used when an exact-out intent is executed as an exact-in (sell) build after
 * the buy→sell refine pass: the user typed a receive target, so the tx must
 * not silently under-deliver vs that floor even if the sell quote's surplus
 * would otherwise be eroded by full slippage.
 *
 * Returns a bps in [0, slippageBps]. When `quotedOut <= minOutFloor`, returns 0
 * (minOut equals the quoted out — the route should already have been filtered
 * to `quotedOut >= floor` at quote time).
 */
export function sellSlippageBpsForMinOutFloor(
  quotedAmountOut: bigint,
  minOutFloor: bigint,
  slippageBps: number,
): number {
  const bps = clampBps(slippageBps);
  if (minOutFloor <= 0n || quotedAmountOut <= 0n) return bps;
  if (quotedAmountOut <= minOutFloor) return 0;
  // Need quoted * (10_000 - s) / 10_000 >= floor
  // ⇔ 10_000 - s >= ceil(floor * 10_000 / quoted)
  const numerator = minOutFloor * 10_000n;
  const minFactor = (numerator + quotedAmountOut - 1n) / quotedAmountOut;
  if (minFactor >= 10_000n) return 0;
  const sMax = Number(10_000n - minFactor);
  return Math.min(bps, sMax);
}

// Trade side + amount-XOR helpers for exact-in (sell) / exact-out (buy).
// Shared by CLI, API handlers, and the dispatcher. Sell is the historical default.

import type { Venue } from "./venues/types.ts";

/** Quote direction: sell = exact-in (fixed amountIn); buy = exact-out (fixed amountOut). */
export type TradeSide = "sell" | "buy";

/**
 * Venues with native exact-out / BUY support planned for v1.
 * The list is the product contract for side=buy: only these race in `-v all`.
 */
export const BUY_CAPABLE_VENUES: readonly Venue[] = [
  "velora",
  "matcha",
  "uniswap",
  "cow",
  "ophis",
];

/**
 * Whether a venue can natively quote/build exact-out (side="buy").
 * The single source of truth is BUY_CAPABLE_VENUES — never hardcode the
 * list at call sites; import this (or the array) instead.
 */
export function isBuyCapable(venue: Venue): boolean {
  return (BUY_CAPABLE_VENUES as readonly string[]).includes(venue);
}

/** Guard that the fixed leg is present for the requested side. */
export function assertQuoteAmount(p: {
  side: TradeSide;
  amountIn?: bigint;
  amountOut?: bigint;
}): void {
  if (p.side === "sell" && p.amountIn == null) {
    throw new Error("sell requires amountIn");
  }
  if (p.side === "buy" && p.amountOut == null) {
    throw new Error("buy requires amountOut");
  }
}

export type ParsedWireAmounts = {
  side: TradeSide;
  /** Fixed when side=sell (base units). */
  amountIn?: bigint;
  /** Fixed when side=buy (base units). */
  amountOut?: bigint;
};

function hasAmount(v: string | undefined | null): v is string {
  return v != null && String(v).length > 0;
}

function parseBaseUnits(field: "amountIn" | "amountOut", raw: string): bigint {
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    throw new Error(`invalid '${field}' (expected base-units integer): ${raw}`);
  }
  if (v < 0n) throw new Error(`'${field}' must be non-negative`);
  return v;
}

/**
 * Parse API wire amounts: exactly one of amountIn | amountOut required
 * (bigint-level, handler-facing). Infers side when omitted; validates
 * consistency when side is provided.
 */
export function parseWireQuoteAmounts(input: {
  amountIn?: string | null;
  amountOut?: string | null;
  side?: string | null;
}): ParsedWireAmounts {
  const hasIn = hasAmount(input.amountIn);
  const hasOut = hasAmount(input.amountOut);

  if (hasIn && hasOut) {
    throw new Error("provide exactly one of amountIn or amountOut");
  }
  if (!hasIn && !hasOut) {
    throw new Error("missing amountIn or amountOut");
  }

  let side: TradeSide;
  if (input.side != null && String(input.side).length > 0) {
    const s = String(input.side);
    if (s !== "sell" && s !== "buy") {
      throw new Error(`invalid side: ${s} (expected sell|buy)`);
    }
    side = s;
    if (side === "sell" && !hasIn) {
      throw new Error("side=sell requires amountIn");
    }
    if (side === "buy" && !hasOut) {
      throw new Error("side=buy requires amountOut");
    }
  } else {
    side = hasIn ? "sell" : "buy";
  }

  return {
    side,
    amountIn: hasIn ? parseBaseUnits("amountIn", input.amountIn!) : undefined,
    amountOut: hasOut ? parseBaseUnits("amountOut", input.amountOut!) : undefined,
  };
}

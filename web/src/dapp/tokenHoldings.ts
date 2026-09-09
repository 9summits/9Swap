// Picker holding rank: which listed tokens a wallet owns, and in what order.
// Pure. The Multicall3 reader lives in walletBalances.ts.

import type { TokenInfo } from "./types";
import { formatUnits } from "./venues";

/** Lowercased token address → base-unit decimal string. */
export type BalanceMap = Record<string, string>;

/**
 * Unique tokens to snapshot, first metadata wins.
 * Insert order: curated, then custom, then recent.
 */
export function collectBalanceTargets(p: {
  curated: TokenInfo[];
  custom: TokenInfo[];
  recent: TokenInfo[];
}): TokenInfo[] {
  const byAddr = new Map<string, TokenInfo>();
  for (const t of [...p.curated, ...p.custom, ...p.recent]) {
    const a = t.address.toLowerCase();
    if (!byAddr.has(a)) byAddr.set(a, t);
  }
  return [...byAddr.values()];
}

function rawBalance(balances: BalanceMap, address: string): string | undefined {
  return balances[address] ?? balances[address.toLowerCase()];
}

/** Same bar as the picker row: formatUnits (6 frac digits). 1 wei of an 18-dec token shows "0". */
function isVisibleHolding(raw: string, decimals: number): boolean {
  try {
    if (BigInt(raw) <= 0n) return false;
  } catch {
    return false;
  }
  return /[1-9]/.test(formatUnits(raw, decimals));
}

/**
 * Stable partition: rows whose displayed balance has a non-zero digit go first.
 * Missing, "0", dust that formatUnits prints as "0", or unparseable stay in rest.
 * Relative order is kept on each side.
 */
export function pinHeldTokens(p: {
  tokens: TokenInfo[];
  balances: BalanceMap | null;
}): { held: TokenInfo[]; rest: TokenInfo[] } {
  const held: TokenInfo[] = [];
  const rest: TokenInfo[] = [];
  if (!p.balances) return { held, rest: [...p.tokens] };
  for (const t of p.tokens) {
    const raw = rawBalance(p.balances, t.address);
    if (raw === undefined || !isVisibleHolding(raw, t.decimals)) rest.push(t);
    else held.push(t);
  }
  return { held, rest };
}

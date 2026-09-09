// Recently selected tokens — localStorage persistence per chain.
//
// When the user picks a token in the TokenSelector (token in or token out),
// we remember it for that chain so the next time they open the picker the
// token sits at the top of the list. Browser-local only (no server, no
// wallet identity) — same storage policy as customTokens.ts.
//
// Shape: chainId (stringified JSON keys) → TokenInfo[] most-recent-first.
// Cap prevents unbounded growth / quota pressure.

import type { TokenInfo } from "./types";

const STORAGE_KEY = "swap.recentTokens.v1";

// Hard ceiling per chain — enough for a user's usual working set without
// drowning the curated list when the section is empty/collapsed.
export const MAX_RECENT_PER_CHAIN = 15;

type Store = Record<string, TokenInfo[]>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    // Corrupt JSON / storage denied — treat as empty, never crash the picker.
    console.error("recentTokens: failed to read store", e);
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    console.error("recentTokens: failed to persist store", e);
  }
}

/** Most-recent-first list for a chain (empty when missing/corrupt). */
export function listRecentTokens(chainId: number): TokenInfo[] {
  return readStore()[String(chainId)] ?? [];
}

/**
 * Record a selection: move `token` to the front of the chain's list,
 * drop any prior entry at the same address, trim to MAX_RECENT_PER_CHAIN.
 */
export function addRecentToken(chainId: number, token: TokenInfo): void {
  const store = readStore();
  const key = String(chainId);
  const addr = token.address.toLowerCase();
  // Normalise address casing for stable dedupe / lookups.
  const entry: TokenInfo = { ...token, address: addr };
  const rest = (store[key] ?? []).filter(
    (t) => t.address.toLowerCase() !== addr,
  );
  store[key] = [entry, ...rest].slice(0, MAX_RECENT_PER_CHAIN);
  writeStore(store);
}

import React from "react";

// <TokenSelector> — modal token picker for one side of the swap pair.
//
// Centered overlay modal (visual reference: the prototype's ConnectModal in
// /tmp/9s-design/ui_kits/swap/app.jsx). A search input sits at the top; below it
// a scrollable list of the chain's curated tokens (GET /api/tokens) rendered as
// TokenBadge + symbol + name (+ balance when supplied). Tokens with a non-zero
// wallet balance are pinned first ("Your tokens"), then recently selected
// tokens for the chain (localStorage, see recentTokens.ts). The query
// fuzzy-filters by symbol/name client-side; when the curated list can't
// satisfy it — a pasted 0x address, or a symbol with no local match — POST
// /api/resolve-token is fired and the resolved token is offered as a pick. That
// endpoint runs the SAME resolver as the CLI (Kyber whitelist → CoinGecko →
// on-chain), so tokens absent from the whitelist (e.g. EURC on mainnet) become
// findable by symbol, not just by address. Clicking a token calls onSelect(token)
// and closes (after recording the pick in the recent store).
//
// Self-contained: imports only from
// ./{types,api,venues,customTokens,recentTokens,tokenHoldings} + ../ds/*.

import { useAccount } from "wagmi";
import type { EIP1193Provider } from "viem";
import { getTokens, resolveToken } from "./api";
import { sessionId } from "../api";
import { formatUnits } from "./venues";
import { addCustomToken, fetchErc20Meta, listCustomTokens } from "./customTokens";
import { addRecentToken, listRecentTokens } from "./recentTokens";
import { pinHeldTokens } from "./tokenHoldings";
import type { TokenInfo, TokenSelectorProps } from "./types";
import { Icon } from "./icons";
import { Input } from "../ds/components/Input";
import { TokenIcon } from "./TokenIcon";
import { Badge } from "../ds/components/Badge";

// A 0x-prefixed 20-byte hex address (the shape resolve-token expects).
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Substring match used by BOTH the live list filter and the "should we resolve
// this query server-side?" decision — keeping them identical means we only hit
// the network when the curated list genuinely has nothing for the query.
function matchesQuery(t: TokenInfo, needle: string): boolean {
  return (
    t.symbol.toLowerCase().includes(needle) ||
    t.name.toLowerCase().includes(needle) ||
    t.address.toLowerCase().includes(needle)
  );
}

/**
 * Build the picker list source order: recent selections for this chain first
 * (MRU), then the curated + custom remainder. `pinHeldTokens` later lifts
 * non-zero balances above this order. Recent entries missing from the curated
 * list (imported / custom) are still shown so they stay one-click reachable.
 * Addresses are lowercased for dedupe; when a recent entry and a curated entry
 * collide we keep the curated metadata (logoURI, full name).
 */
function mergeTokenList(
  curated: TokenInfo[],
  custom: TokenInfo[],
  recent: TokenInfo[],
): { tokens: TokenInfo[]; recentAddrs: Set<string>; customAddrs: Set<string> } {
  const byAddr = new Map<string, TokenInfo>();
  for (const t of curated) byAddr.set(t.address.toLowerCase(), t);
  for (const t of custom) {
    const a = t.address.toLowerCase();
    if (!byAddr.has(a)) byAddr.set(a, t);
  }
  // Enrich recent rows with curated metadata when available (logo, proper name).
  const recentRows: TokenInfo[] = [];
  const recentAddrs = new Set<string>();
  for (const t of recent) {
    const a = t.address.toLowerCase();
    if (recentAddrs.has(a)) continue;
    recentAddrs.add(a);
    recentRows.push(byAddr.get(a) ?? t);
  }
  const rest: TokenInfo[] = [];
  for (const t of curated) {
    if (!recentAddrs.has(t.address.toLowerCase())) rest.push(t);
  }
  for (const t of custom) {
    const a = t.address.toLowerCase();
    if (!recentAddrs.has(a) && !curated.some((c) => c.address.toLowerCase() === a)) {
      rest.push(t);
    }
  }
  return {
    tokens: [...recentRows, ...rest],
    recentAddrs,
    customAddrs: new Set(custom.map((t) => t.address.toLowerCase())),
  };
}

// TokenSelectorProps is the fixed prop contract (types.ts). `balances` is an
// optional additive prop — address (lowercased) → base-units string — so the
// list can show per-token balances without changing the shared interface.
export type TokenSelectorOwnProps = TokenSelectorProps & {
  balances?: Record<string, string> | null;
};

export function TokenSelector({
  chain,
  value,
  onSelect,
  onClose,
  open,
  balances = null,
}: TokenSelectorOwnProps) {
  const [query, setQuery] = React.useState("");
  const [tokens, setTokens] = React.useState<TokenInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [listError, setListError] = React.useState<string | null>(null);

  // Address-resolution state (only used when the query is a 0x address that's
  // not already in the curated list).
  const [resolved, setResolved] = React.useState<TokenInfo | null>(null);
  const [resolving, setResolving] = React.useState(false);
  const [resolveError, setResolveError] = React.useState<string | null>(null);
  // True when `resolved` came from the on-chain ERC20 fallback (server resolver
  // missed) — picking it persists the token to the per-chain localStorage store.
  const [resolvedIsCustom, setResolvedIsCustom] = React.useState(false);
  // Lowercased addresses of stored custom tokens merged into the list below,
  // so their rows carry a "custom" badge.
  const [customAddrs, setCustomAddrs] = React.useState<Set<string>>(new Set());
  // Lowercased addresses of recent selections for this chain — first N rows of
  // the list when the search box is empty; rows carry a "recent" badge.
  const [recentAddrs, setRecentAddrs] = React.useState<Set<string>>(new Set());

  // For the on-chain fallback: read through the connected wallet's provider
  // when it sits on the selected chain (same policy as the balance reads).
  // Snapshotted into a ref read at lookup time — as effect deps these would
  // re-fire the resolve on every wallet connect/reconnect/chain-switch event,
  // wiping an already-displayed result from under the user's cursor. The
  // effect's cancelled flag already covers the wrong-chain race.
  const { chainId: walletChainId, connector } = useAccount();
  const walletRef = React.useRef({ chainId: walletChainId, connector });
  walletRef.current = { chainId: walletChainId, connector };

  const sid = sessionId();
  const q = query.trim();
  const looksLikeAddress = ADDRESS_RE.test(q);
  // A symbol-ish query we can hand to the backend resolver when the curated
  // list has nothing for it (≥2 chars avoids firing on a single keystroke).
  const looksLikeSymbol = !looksLikeAddress && q.length >= 2;

  // Load the curated token list whenever the modal opens for a chain. Reset the
  // search box each open so a stale query doesn't carry across chains/sides.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setResolved(null);
    setResolveError(null);
    setResolvedIsCustom(false);
    let cancelled = false;
    setLoading(true);
    setListError(null);
    getTokens(sid, chain.alias)
      .then((list) => {
        if (cancelled) return;
        // Recent (MRU) first, then curated + custom remainder. Custom badge
        // only on user-imported rows; recent badge on the pinned head.
        const merged = mergeTokenList(
          list,
          listCustomTokens(chain.chainId),
          listRecentTokens(chain.chainId),
        );
        setTokens(merged.tokens);
        setCustomAddrs(merged.customAddrs);
        setRecentAddrs(merged.recentAddrs);
      })
      .catch((err: unknown) => {
        // Never swallow: surface the failure in the modal body.
        const msg = err instanceof Error ? err.message : String(err);
        console.error("TokenSelector: getTokens failed", err);
        if (!cancelled) {
          setListError(msg);
          // Recent + custom live locally — still usable when the list fetch dies.
          const merged = mergeTokenList(
            [],
            listCustomTokens(chain.chainId),
            listRecentTokens(chain.chainId),
          );
          setTokens(merged.tokens);
          setCustomAddrs(merged.customAddrs);
          setRecentAddrs(merged.recentAddrs);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, chain.alias, chain.chainId, sid]);

  // Resolve the query server-side when the curated list can't satisfy it:
  //   • a pasted 0x address not already listed, or
  //   • a symbol with no local match — the backend runs the SAME resolver as
  //     the CLI (Kyber whitelist → CoinGecko → on-chain), so tokens missing
  //     from the whitelist (e.g. EURC on mainnet) become findable by symbol.
  // Gated on "no local match" + debounced so we never hit the network for a
  // token already in the list, and keystrokes don't fan out duplicate calls.
  React.useEffect(() => {
    if (!open) return;
    setResolved(null);
    setResolveError(null);
    setResolvedIsCustom(false);

    const lower = q.toLowerCase();
    const addressMiss =
      looksLikeAddress && !tokens.some((t) => t.address.toLowerCase() === lower);
    const symbolMiss =
      looksLikeSymbol && !tokens.some((t) => matchesQuery(t, lower));
    if (!addressMiss && !symbolMiss) {
      // A prior run may have armed the debounce timer and set `resolving`
      // before being cancelled by a dep change (its cleanup clears the timer,
      // so nothing ever resets the flag) — a stale "Searching…" row would
      // linger. This run is authoritative: no miss ⇒ not resolving.
      setResolving(false);
      return;
    }

    let cancelled = false;
    setResolving(true);
    const handle = setTimeout(() => {
      (async () => {
        // On-chain ERC20 lookup via the USER's RPC (wallet provider when it's
        // on this chain, the chain's default public RPC otherwise). Picking the
        // result stores it as a custom token. Returns null on success, the
        // error message on failure.
        const onchainLookup = async (): Promise<string | null> => {
          try {
            const wallet = walletRef.current;
            let walletProvider: EIP1193Provider | undefined;
            if (wallet.chainId === chain.chainId && wallet.connector?.getProvider) {
              walletProvider = (await wallet.connector
                .getProvider()
                .catch(() => undefined)) as EIP1193Provider | undefined;
            }
            const tok = await fetchErc20Meta(chain.chainId, q, walletProvider);
            if (!cancelled) {
              setResolved(tok);
              setResolvedIsCustom(true);
            }
            return null;
          } catch (err) {
            console.error("TokenSelector: on-chain ERC20 lookup failed", err);
            return err instanceof Error ? err.message : String(err);
          }
        };
        try {
          const tok = await resolveToken(sid, chain.alias, q);
          if (cancelled) return;
          // "unknown token" is the server resolver's last-resort placeholder
          // (only decimals are real — Kyber and CoinGecko both missed). Try to
          // upgrade it to the real name/symbol read on-chain client-side; keep
          // the placeholder if that read fails too.
          if (addressMiss && tok.name === "unknown token" && (await onchainLookup()) === null) {
            return;
          }
          if (!cancelled) setResolved(tok);
        } catch (err) {
          console.error("TokenSelector: resolveToken failed", err);
          if (cancelled) return;
          if (!addressMiss) {
            setResolveError(err instanceof Error ? err.message : String(err));
            return;
          }
          // Pasted address the server can't identify at all → the on-chain
          // path is the only remaining source.
          const lookupError = await onchainLookup();
          if (lookupError !== null && !cancelled) setResolveError(lookupError);
        } finally {
          if (!cancelled) setResolving(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, q, looksLikeAddress, looksLikeSymbol, tokens, chain.alias, chain.chainId, sid]);

  if (!open) return null;

  // Fuzzy-ish client filter: match symbol or name (case-insensitive substring),
  // or an address prefix when the query starts with 0x. An exact address query
  // is handled by the resolve path above, so here we keep substring matching on
  // the curated list for partial-address typing too.
  const needle = q.toLowerCase();
  const filtered = needle ? tokens.filter((t) => matchesQuery(t, needle)) : tokens;
  const { held, rest } = pinHeldTokens({ tokens: filtered, balances });
  const ranked = [...held, ...rest];
  const heldAddrs = new Set(held.map((t) => t.address.toLowerCase()));

  const selectedAddr = value ? value.address.toLowerCase() : null;

  function pick(token: TokenInfo) {
    // MRU per chain — so the next open pins this token at the top of the list.
    addRecentToken(chain.chainId, token);
    onSelect(token);
    onClose();
  }

  // Per-token balance lookup (case-insensitive on address) → human string.
  function balanceFor(token: TokenInfo): string | null {
    if (!balances) return null;
    const raw =
      balances[token.address] ?? balances[token.address.toLowerCase()];
    if (raw === undefined) return null;
    return formatUnits(raw, token.decimals);
  }

  // The resolve row is shown whenever a server resolution is in flight, landed,
  // or failed — those states are only ever set after a genuine list miss above,
  // so this covers both the address-paste and symbol-search paths.
  const showResolveRow = resolving || !!resolved || !!resolveError;

  return (
    <div style={d.overlay} onClick={onClose}>
      <div
        style={d.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Select a token"
      >
        {/* header */}
        <div style={d.head}>
          <span style={d.title}>Select a token</span>
          <button
            style={d.closeBtn}
            onClick={onClose}
            aria-label="Close"
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-strong)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-tertiary)")}
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* search */}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search symbol/name or paste address"
          prefix={<Icon name="search" size={18} />}
          mono={looksLikeAddress}
          size="lg"
          autoFocus
          style={{ marginBottom: 14 }}
        />

        {/* list */}
        <div style={d.list}>
          {/* resolved-by-address pick row */}
          {showResolveRow && (
            <div style={d.resolveBlock}>
              <div style={d.resolveLabel}>
                {resolving
                  ? looksLikeAddress
                    ? "Resolving address…"
                    : "Searching…"
                  : resolved
                    ? resolvedIsCustom
                      ? "Custom token (read on-chain)"
                      : "Imported token"
                    : looksLikeAddress
                      ? "Address"
                      : "Search"}
              </div>
              {resolved && (
                <TokenRow
                  token={resolved}
                  chainId={chain.chainId}
                  selected={selectedAddr === resolved.address.toLowerCase()}
                  balance={balanceFor(resolved)}
                  tag={resolvedIsCustom ? "custom" : "imported"}
                  onPick={(t) => {
                    // Persist any picker import (server resolve or on-chain
                    // fallback) so Manage custom tokens lists it next visit.
                    addCustomToken(chain.chainId, t);
                    pick(t);
                  }}
                />
              )}
              {/* Import-risk warning: symbol/name are self-reported by the
                  contract — a scam can call itself "USDC". Shown BEFORE the
                  pick persists it; extra-loud when the symbol collides with a
                  listed token. */}
              {resolved && resolvedIsCustom && (() => {
                const collides = tokens.some(
                  (t) =>
                    t.symbol.toLowerCase() === resolved.symbol.toLowerCase() &&
                    t.address.toLowerCase() !== resolved.address.toLowerCase(),
                );
                return (
                  <div style={{ ...d.customWarn, ...(collides ? d.customWarnHot : null) }}>
                    <Icon
                      name="alert"
                      size={14}
                      style={{ flex: "none", color: collides ? "var(--negative)" : "var(--text-tertiary)" }}
                    />
                    <span>
                      {collides && (
                        <strong style={{ color: "var(--negative)" }}>
                          "{resolved.symbol}" matches an already-listed token — likely an imitation.{" "}
                        </strong>
                      )}
                      Anyone can deploy a token with any name. Verify the contract:{" "}
                      <span style={d.customWarnAddr}>{resolved.address}</span>
                    </span>
                  </div>
                );
              })()}
              {resolving && !resolved && (
                <div style={d.muted}>
                  <Icon name="spinner" size={15} style={{ color: "var(--text-tertiary)" }} />
                  <span>
                    {looksLikeAddress
                      ? `Looking up ${q.slice(0, 6)}…${q.slice(-4)}`
                      : `Searching "${q}"`}
                  </span>
                </div>
              )}
              {resolveError && !resolved && (
                <div style={{ ...d.muted, color: "var(--negative)" }}>
                  <Icon name="alert" size={15} />
                  <span>
                    {looksLikeAddress
                      ? `Could not resolve this address on ${chain.name}.`
                      : `No token "${q}" found on ${chain.name}. Try pasting its address.`}
                  </span>
                </div>
              )}
            </div>
          )}

          {loading && (
            <div style={d.muted}>
              <Icon name="spinner" size={15} style={{ color: "var(--text-tertiary)" }} />
              <span>Loading {chain.name} tokens…</span>
            </div>
          )}

          {listError && !loading && (
            <div style={{ ...d.muted, color: "var(--negative)" }}>
              <Icon name="alert" size={15} />
              <span>Failed to load tokens.</span>
            </div>
          )}

          {/* NOT gated on listError: when the curated fetch dies, `tokens`
              still holds the locally-stored custom tokens (set in the catch
              branch above) — they must stay visible and pickable. */}
          {!loading &&
            ranked.map((t, i) => {
              const addr = t.address.toLowerCase();
              const inHeld = heldAddrs.has(addr);
              const inRecent = recentAddrs.has(addr);
              // Prefer "custom" over "recent". Held rows sit under "Your tokens"
              // so they don't also wear a recent badge. Only badge "recent"
              // while unfiltered so the mark stays on the pinned head.
              const tag = customAddrs.has(addr)
                ? "custom"
                : !needle && inRecent && !inHeld
                  ? "recent"
                  : null;
              const prev = i > 0 ? ranked[i - 1]! : null;
              const prevHeld = !!prev && heldAddrs.has(prev.address.toLowerCase());
              const prevRecent =
                !!prev &&
                recentAddrs.has(prev.address.toLowerCase()) &&
                !heldAddrs.has(prev.address.toLowerCase());
              const showHeldHeader = !needle && inHeld && !prevHeld;
              const showRecentHeader =
                !needle && !inHeld && inRecent && (i === 0 || prevHeld);
              const showAllHeader =
                !needle &&
                !inHeld &&
                !inRecent &&
                (held.length > 0 || recentAddrs.size > 0) &&
                (i === 0 || prevHeld || prevRecent);
              return (
                <React.Fragment key={`${t.address}-${t.symbol}`}>
                  {showHeldHeader && (
                    <div style={d.resolveLabel}>Your tokens</div>
                  )}
                  {showRecentHeader && (
                    <div style={d.resolveLabel}>Recent</div>
                  )}
                  {showAllHeader && (
                    <div style={d.resolveLabel}>All tokens</div>
                  )}
                  <TokenRow
                    token={t}
                    chainId={chain.chainId}
                    selected={selectedAddr === addr}
                    balance={balanceFor(t)}
                    tag={tag}
                    onPick={pick}
                  />
                </React.Fragment>
              );
            })}

          {/* empty state — nothing matched and nothing to resolve */}
          {!loading && !listError && ranked.length === 0 && !showResolveRow && (
            <div style={d.empty}>
              <Icon name="search" size={20} style={{ color: "var(--text-tertiary)" }} />
              <span style={{ fontWeight: 700, color: "var(--text-secondary)" }}>
                No tokens match "{q}"
              </span>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                Paste a contract address to import a token.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- row ----------------------------------- */

function TokenRow({
  token,
  chainId,
  selected,
  balance,
  tag = null,
  onPick,
}: {
  token: TokenInfo;
  // Scopes the icon fallback CDNs (TrustWallet is per-chain).
  chainId: number;
  selected: boolean;
  balance: string | null;
  // Row badge label ("imported" / "custom" / "recent"); null for regular rows.
  tag?: string | null;
  onPick: (t: TokenInfo) => void;
}) {
  return (
    <button
      type="button"
      style={{
        ...d.row,
        background: selected ? "var(--brand-soft)" : "transparent",
        borderColor: selected ? "var(--border-brand)" : "transparent",
      }}
      onClick={() => onPick(token)}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--surface-frost)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <TokenIcon token={token} chainId={chainId} bare size="lg" lazy />
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, textAlign: "left" }}>
          <span style={d.rowSym}>
            {token.symbol}
            {tag && (
              <Badge tone="brand" size="sm" style={{ marginLeft: 8 }}>
                {tag}
              </Badge>
            )}
          </span>
          <span style={d.rowName}>{token.name}</span>
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
        {balance !== null && <span style={d.rowBal}>{balance}</span>}
        {selected && <Icon name="check" size={17} style={{ color: "var(--brand-solid)" }} />}
      </span>
    </button>
  );
}

/* -------------------------------- styles --------------------------------- */

const d: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    background: "var(--surface-overlay)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modal: {
    width: 420,
    maxWidth: "92vw",
    maxHeight: "82vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-2xl)",
    boxShadow: "var(--shadow-xl)",
    padding: 22,
    boxSizing: "border-box",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  title: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 18,
    color: "var(--text-strong)",
  },
  closeBtn: {
    display: "inline-flex",
    padding: 6,
    background: "transparent",
    border: "none",
    color: "var(--text-tertiary)",
    cursor: "pointer",
    transition: "color var(--dur-base) var(--ease-out)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    overflowY: "auto",
    margin: "0 -6px",
    padding: "0 6px",
    minHeight: 0,
  },
  resolveBlock: {
    marginBottom: 8,
    paddingBottom: 8,
    borderBottom: "1px solid var(--border-subtle)",
  },
  customWarn: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    margin: "6px 10px 2px",
    padding: "8px 10px",
    fontSize: 11.5,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
    background: "var(--surface-frost)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-md)",
  },
  customWarnHot: {
    background: "var(--negative-bg)",
    borderColor: "rgba(255,92,108,0.4)",
  },
  customWarnAddr: {
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    wordBreak: "break-all",
    color: "var(--text-strong)",
  },
  resolveLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    padding: "4px 10px 8px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    width: "100%",
    padding: "10px 12px",
    border: "1px solid transparent",
    borderRadius: "var(--radius-lg)",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    transition: "background var(--dur-base) var(--ease-out)",
  },
  rowSym: {
    display: "flex",
    alignItems: "center",
    fontFamily: "var(--font-sans)",
    fontWeight: 700,
    fontSize: 15,
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
  },
  rowName: {
    fontSize: 12,
    color: "var(--text-tertiary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 220,
  },
  rowBal: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-secondary)",
    fontFeatureSettings: '"tnum" 1',
    whiteSpace: "nowrap",
  },
  muted: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "12px 12px",
    fontSize: 13,
    color: "var(--text-secondary)",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "32px 16px",
    textAlign: "center",
  },
};

import React from "react";
import type { RoutesPaneProps, RouteQuote } from "./types";
import { vmeta, vlogo, formatUnits, formatUsd } from "./venues";
import { humanVenueReason } from "./venueReason";
import { Icon } from "./icons";
import { Badge } from "../ds/components/Badge";
import { Switch } from "../ds/components/Switch";

// <RoutesPane> — the right-hand ranked-venue panel of the Direction-A two-pane
// aggregator. Ported faithfully from the swap prototype
// (/tmp/9s-design/ui_kits/swap/app.jsx) and made LIVE: it renders the ranked
// `quote.routes[]` from /api/quote, highlights the `selectedVenue`, and calls
// `onSelect(venue)` when a row is clicked (the whole row is clickable).
//
// When `action` is supplied (wrap / unwrap / send — the no-routing modes) the
// pane renders that node in place of the ranked list, mirroring the prototype's
// "Route" / no-routing note. When `action` is null and a quote is present, it
// renders the ranked venue list.

// VenueMark — the round venue glyph: the real protocol logo (DeFiLlama CDN)
// over the brand tint, falling back to the tinted monogram if the logo URL
// is unknown or fails to load.
function VenueMark({ venue, size = 30 }: { venue: string; size?: number }) {
  const m = vmeta(venue);
  const logo = vlogo(venue);
  const [failed, setFailed] = React.useState(false);
  const showLogo = logo && !failed;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        background: showLogo ? "var(--ink-800)" : m.tint,
        color: "#fff",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: size * 0.42,
        boxShadow: "var(--shadow-inset)",
      }}
    >
      {showLogo ? (
        <img
          src={logo}
          alt={m.label}
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: "cover", display: "block" }}
          onError={() => setFailed(true)}
        />
      ) : (
        m.label[0]
      )}
    </span>
  );
}

// Small icon button in the Routes header that re-quotes on click. While a
// refresh is streaming the icon spins; otherwise a circular progress ring
// around the icon depletes with the time left until the quote auto-refreshes
// (`fraction` ∈ [0,1] of the TTL remaining).
function RefreshButton({
  onClick,
  spinning,
  fraction,
  disabled,
}: {
  onClick: () => void;
  spinning?: boolean;
  fraction: number | null;
  disabled?: boolean;
}) {
  // The SVG fills the whole 28×28 button (viewBox 0 0 28, center 14,14). The
  // ring radius (12) keeps the 2px stroke at radius 11–13 — comfortably inside
  // the 14px half-extent — so a full-size, inset:0 SVG is perfectly centered
  // and the arc can never spill past the button edge. (The earlier 26×26 SVG
  // sat top-left in the 28px box and rendered the arc off-center.)
  const R = 12;
  const C = 2 * Math.PI * R;
  const showRing = !spinning && fraction !== null;
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={!!disabled}
      aria-label="Refresh routes"
      title="Refresh routes"
      style={{
        ...d.refreshBtn,
        ...(disabled
          ? {
              opacity: 0.45,
              cursor: "default",
              background: "var(--surface-frost)",
              color: "var(--text-tertiary)",
            }
          : {}),
      }}
      onMouseEnter={
        disabled
          ? undefined
          : (e) => {
              e.currentTarget.style.background = "var(--surface-frost-strong)";
              e.currentTarget.style.color = "var(--text-strong)";
            }
      }
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--surface-frost)";
        e.currentTarget.style.color = "var(--text-tertiary)";
      }}
    >
      {showRing && (
        <svg
          width={28}
          height={28}
          viewBox="0 0 28 28"
          aria-hidden="true"
          style={{
            // Center on the button via transform (border-width-agnostic):
            // top/left:0 would anchor to the padding box, inside the 1px
            // border, leaving the ring 1px off toward the bottom-right.
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%) rotate(-90deg)",
            pointerEvents: "none",
          }}
        >
          <circle
            cx={14}
            cy={14}
            r={R}
            fill="none"
            stroke="var(--border-default)"
            strokeWidth={2}
          />
          <circle
            cx={14}
            cy={14}
            r={R}
            fill="none"
            stroke="var(--brand-solid)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - fraction!)}
            style={{ transition: "stroke-dashoffset 1s linear" }}
          />
        </svg>
      )}
      <Icon
        name="refresh"
        size={14}
        style={
          spinning ? { animation: "spin9 0.8s linear infinite" } : undefined
        }
      />
    </button>
  );
}

export function RoutesPane({
  quote,
  selectedVenue,
  onSelect,
  action,
  onRefresh,
  streaming,
  secondsToExpiry,
  allowAsync,
  onAllowAsync,
  refreshLocked,
}: RoutesPaneProps) {
  // Self-calibrating TTL for the refresh ring: the first secondsToExpiry seen
  // for a quote round ≈ the full TTL (the backend stamps expiresAt when the
  // round settles). Tracked per quoteId so a new round re-anchors the ring.
  const ttlRef = React.useRef<{ id: string; total: number } | null>(null);
  // List body: while a re-stream is in flight we lock minHeight to the last
  // measured height so replacing N routes with the first new one doesn't
  // collapse the right pane (and shift the three-column grid). Released when
  // the stream settles so a shorter final list can shrink naturally.
  const listRef = React.useRef<HTMLDivElement>(null);
  const lockedHRef = React.useRef<number | null>(null);
  const [listMinH, setListMinH] = React.useState<number | undefined>(undefined);

  const hasRoutes = !!quote && quote.routes.length > 0;
  // Spins until ALL venues have settled (not just the first route).
  const busy = !!streaming;
  // Keep the refresh button visible whenever there are routes OR a fetch is in
  // flight (so it doesn't vanish mid-stream).
  const showRefresh = !!onRefresh && (hasRoutes || busy);

  // Capture height before the progressive list shrinks; hold it while busy.
  // Must run before any early return (rules of hooks).
  React.useLayoutEffect(() => {
    if (action) return; // no-routing modes don't use the ranked list
    if (busy) {
      const h = listRef.current?.offsetHeight ?? 0;
      if (h > 0) lockedHRef.current = Math.max(lockedHRef.current ?? 0, h);
      if (lockedHRef.current != null && lockedHRef.current > 0) {
        setListMinH(lockedHRef.current);
      }
    } else {
      lockedHRef.current = null;
      setListMinH(undefined);
    }
  }, [action, busy, quote?.routes.length]);

  // No-routing modes (wrap / unwrap / send): render the supplied `action` node
  // (the prototype's "no routing" note) under a "Route" header.
  if (action) {
    return (
      <div style={d.routes}>
        <div style={d.routesHead}>
          <span style={d.paneTitle}>Venues</span>
        </div>
        {action}
      </div>
    );
  }

  // Remaining fraction of the quote TTL for the ring around the refresh button.
  const secs = secondsToExpiry ?? null;
  let fraction: number | null = null;
  if (quote && secs !== null) {
    if (!ttlRef.current || ttlRef.current.id !== quote.quoteId) {
      ttlRef.current = { id: quote.quoteId, total: Math.max(secs, 1) };
    } else if (secs > ttlRef.current.total) {
      ttlRef.current.total = secs;
    }
    fraction = Math.max(0, Math.min(1, secs / ttlRef.current.total));
  }

  // Shared header: title + intent toggle + time-to-refresh countdown + refresh.
  // The intent toggle (was the SettingsPopover's "Include intent venues") lives
  // here, always visible, so async/intent venues can be flipped on without
  // opening settings — it directly affects which venues appear in this list.
  // Countdown keeps a fixed mono slot while busy so the header doesn't shift
  // when the spinner replaces the ring.
  const intentToggle = (
    <button
      type="button"
      onClick={() => onAllowAsync(!allowAsync)}
      style={d.intentToggle}
      role="switch"
      aria-checked={allowAsync}
      aria-label="Include intent venues"
      title="Include intent venues — async auctions (CoW, UniswapX, …) settle off-chain: you sign an order instead of broadcasting a tx."
    >
      <span style={d.intentToggleLabel}>Intent</span>
      <Switch checked={allowAsync} interactive={false} size="sm" />
    </button>
  );
  const header = (
    <div style={d.routesHead}>
      <span style={d.paneTitle}>Venues</span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {intentToggle}
        {showRefresh && secs !== null && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              fontFeatureSettings: '"tnum" 1',
              // Fixed width (~2 digits + "s") so 9s→10s and hide/show don't nudge
              // the refresh button. Invisible while spinning (ring gone, spinner on).
              minWidth: "2.5ch",
              textAlign: "right",
              visibility: busy ? "hidden" : "visible",
              color: secs <= 3 ? "var(--warning)" : "var(--text-tertiary)",
            }}
          >
            {secs}s
          </span>
        )}
        {showRefresh && (
          <RefreshButton
            onClick={onRefresh!}
            spinning={busy}
            fraction={fraction}
            disabled={!!refreshLocked}
          />
        )}
      </div>
    </div>
  );

  // Empty list: first quote, incomplete form, or a refresh purge (manual
  // or auto). minHeight still locks once the first new route arrives and
  // the list grows.
  if (!hasRoutes) {
    return (
      <div style={d.routes}>
        {header}
        {busy && (
          <div style={{ padding: "10px 2px", fontSize: 13, color: "var(--text-tertiary)" }}>
            Comparing venues…
          </div>
        )}
      </div>
    );
  }

  const routes = quote!.routes;
  // Side-aware ranking display: sell ranks by minAmountOut ?? amountOut (the
  // guaranteed floor when a venue's cote is optimistic, e.g. Fusion);
  // buy ranks by amountIn. The row still shows the cote, with min underneath.
  const isBuy = (quote!.side ?? "sell") === "buy";
  const dispDecimals = isBuy ? quote!.tokenIn.decimals : quote!.tokenOut.decimals;
  // routes[] is ranked best-first; the best row's rank key anchors the gap.
  let anchor = 0n;
  try {
    const best = routes[0];
    anchor = BigInt(
      isBuy ? best.amountIn : (best.minAmountOut ?? best.amountOut),
    );
  } catch {
    anchor = 0n;
  }

  return (
    <div style={d.routes}>
      {header}
      <div
        ref={listRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 9,
          minHeight: listMinH,
        }}
      >
        {routes.map((q, i) => (
          <RouteRow
            key={q.venue}
            q={q}
            isBest={i === 0}
            selected={selectedVenue === q.venue}
            isBuy={isBuy}
            anchor={anchor}
            dispDecimals={dispDecimals}
            onSelect={onSelect}
          />
        ))}
      </div>
      {quote!.unavailable && quote!.unavailable.length > 0 && (
        <UnavailableVenues items={quote!.unavailable} />
      )}
    </div>
  );
}

function RouteRow({
  q,
  isBest,
  selected,
  isBuy,
  anchor,
  dispDecimals,
  onSelect,
}: {
  q: RouteQuote;
  isBest: boolean;
  selected: boolean;
  isBuy: boolean;
  anchor: bigint;
  dispDecimals: number;
  onSelect: (venue: string) => void;
}) {
  // Displayed cote: receive (tokenOut) on sell, pay (tokenIn) on buy.
  const rowAmountBase = isBuy ? q.amountIn : q.amountOut;
  // Rank key: Fusion's auction-end floor on sell, else the cote / pay amount.
  const rankAmountBase = isBuy
    ? q.amountIn
    : (q.minAmountOut ?? q.amountOut);
  // Gap vs the best row, as a percentage off the rank-key diff (exactness).
  // sell: best − this (you receive LESS → shown "−"). buy: this − best (you pay
  // MORE → shown "+"). Null on the best row, which shows nothing there.
  let gapLabel: string | null = null;
  if (!isBest) {
    try {
      const diff = isBuy
        ? BigInt(q.amountIn) - anchor
        : anchor - BigInt(rankAmountBase);
      if (anchor > 0n) {
        gapLabel =
          (isBuy ? "+" : "−") +
          ((Number(diff) / Number(anchor)) * 100).toFixed(2) +
          "%";
      }
    } catch (err) {
      console.warn("[RoutesPane] gap vs best unavailable for", q.venue, err);
    }
  }

  const amountOut = formatUnits(rowAmountBase, dispDecimals, 6);
  const minLabel =
    !isBuy && q.minAmountOut
      ? `min ${formatUnits(q.minAmountOut, dispDecimals, 6)}`
      : null;
  // Intent venues quote gas-inclusive: the solver pays settlement gas out of the
  // price, so a null gasUsd there means "included", not "unknown".
  const gasLabel =
    q.gasUsd !== null ? formatUsd(q.gasUsd) : q.kind === "async" ? "incl." : "—";

  // Only the SELECTED row carries the brand highlight. `selectedVenue` resolves
  // to exactly one venue (the pinned one, or the best when nothing is pinned),
  // so the highlight never doubles up on the top row — the "Best" badge alone
  // marks the best venue when another row is selected.
  const border = selected ? "var(--border-brand)" : "var(--border-subtle)";
  const bg = selected ? "var(--brand-soft)" : "var(--surface-card)";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(q.venue)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(q.venue);
        }
      }}
      style={{
        ...d.routeItem,
        borderColor: border,
        background: bg,
        outline: selected ? "1px solid var(--border-brand)" : "none",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <VenueMark venue={q.venue} />
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-strong)" }}>
              {vmeta(q.venue).label}
            </span>
            {isBest && (
              <Badge tone="positive" size="sm" dot>
                Best
              </Badge>
            )}
            {q.kind === "async" && (
              <Badge tone="info" size="sm">
                intent
              </Badge>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 3,
              color: "var(--text-tertiary)",
              fontSize: 12,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Icon name="gas" size={12} /> {gasLabel}
            </span>
          </div>
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 15,
            color: "var(--text-strong)",
            fontFeatureSettings: '"tnum" 1',
          }}
        >
          {amountOut}
        </div>
        {minLabel && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              marginTop: 2,
              fontFamily: "var(--font-mono)",
              fontFeatureSettings: '"tnum" 1',
            }}
          >
            {minLabel}
          </div>
        )}
        {gapLabel && (
          <div
            style={{
              fontSize: 11,
              color: "var(--negative)",
              marginTop: 2,
              fontFamily: "var(--font-mono)",
              fontFeatureSettings: '"tnum" 1',
            }}
          >
            {gapLabel}
          </div>
        )}
      </div>
    </div>
  );
}

// <UnavailableVenues> — venues that were queried but couldn't quote this pair
// (e.g. intent venues reject native-ETH input, or a missing API key). Shown
// muted below the ranked list so the user understands WHY a venue is absent
// instead of it silently vanishing.
function UnavailableVenues({
  items,
}: {
  items: { venue: string; reason: string }[];
}) {
  return (
    <div style={d.unavail}>
      <div style={d.unavailHead}>
        {items.length} {items.length === 1 ? "venue" : "venues"} unavailable
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it) => (
          <div key={it.venue} style={d.unavailRow}>
            <span
              style={{ ...d.unavailDot, background: vmeta(it.venue).tint }}
              aria-hidden="true"
            />
            <span style={d.unavailLabel}>{vmeta(it.venue).label}</span>
            <span style={d.unavailReason} title={it.reason}>
              {humanVenueReason(it.venue, it.reason)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const d: Record<string, React.CSSProperties> = {
  routes: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    padding: 18,
    // Fill the grid track; never grow it (long mono amounts / venue names).
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  routesHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  intentToggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "3px 7px 3px 9px",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-frost)",
    cursor: "pointer",
  },
  intentToggleLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  },
  paneTitle: {
    fontFamily: "var(--font-display)",
    fontSize: 17,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
  refreshBtn: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    flex: "none",
    // Kill the legacy page's global `button { padding: 10px 18px }` (from
    // web/index.html) — with it, the 28px width clamps to padding+border=38px
    // and the countdown ring renders off-center on an oval button.
    padding: 0,
    // Circular, so the countdown ring hugs the button's own edge.
    borderRadius: "50%",
    border: "1px solid var(--border-default)",
    background: "var(--surface-frost)",
    color: "var(--text-tertiary)",
    cursor: "pointer",
    transition:
      "background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out)",
  },
  routeItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 14px",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
  },
  unavail: {
    marginTop: 14,
    paddingTop: 12,
    borderTop: "1px solid var(--border-subtle)",
  },
  unavailHead: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    marginBottom: 8,
  },
  // The reason wraps instead of being ellipsed: a readable sentence beats a
  // truncated one. Row aligns to the top so a two-line reason keeps the dot and
  // the venue label on the first line.
  unavailRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    opacity: 0.7,
  },
  unavailDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flex: "none",
    marginTop: 5,
    filter: "grayscale(0.4)",
  },
  unavailLabel: {
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.35,
    color: "var(--text-secondary)",
    flex: "none",
  },
  unavailReason: {
    fontSize: 11,
    lineHeight: 1.35,
    color: "var(--text-tertiary)",
    flex: "1 1 auto",
    minWidth: 0,
    textAlign: "right",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
};

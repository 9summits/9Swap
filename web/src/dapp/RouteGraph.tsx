import React from "react";
import {
  sankey,
  sankeyLinkHorizontal,
  sankeyLeft,
  type SankeyGraph,
  type SankeyNode,
  type SankeyLink,
} from "d3-sankey";
import type { RouteGraphResponse } from "./types";
import { formatUnits } from "./venues";
import { Icon } from "./icons";

// <RouteGraph> — an Odos-style Sankey flow diagram of the selected venue's
// route, laid out with d3-sankey and rendered as gradient ribbons. Tokens are
// the nodes; each hop is a ribbon whose width is proportional to the share of
// its source token routed through it, coloured per protocol/pool (legend below).
// Fed by POST /api/route's symbol-labelled hops.
//
// Readability: the SVG renders at the container's measured pixel width (1:1, no
// down-scaling that would shrink labels into mush), and every node label is
// drawn in a solid grey pill ON TOP of the ribbons so it stays legible no matter
// how dense the flows are. Hovering a ribbon shows a tooltip with the protocol,
// the source token, its share of the flow, and the humanised input amount.
//
// Dense routes outgrow the narrow card no matter how the labels are managed, so
// the card header carries a "Show more" link that opens <RouteModal> — a
// 90vw × 90vh overlay rendering the same graph on the full surface. The actual
// SVG (measure → layout → ribbons → tooltip → legend) lives in <SankeySurface>,
// shared by the card and the modal; each instance measures its own container
// and lays out independently.

type Hop = {
  from: string;
  to: string;
  exchange: string;
  swapAmount: string;
  // Split weight in the route input token's units, not this hop's tokenIn
  // (openocean / 1inch downstream hops) — ratio math only, never humanise.
  approxAmount?: boolean;
  amountOut?: string;
  fromName: string;
  fromDecimals: number;
  toDecimals: number;
};

// Vivid, well-separated palette for protocols/pools.
const PALETTE = [
  "#ff2d78", "#16c79a", "#7c5cff", "#3b82f6", "#f59e0b",
  "#fb7185", "#22d3ee", "#a855f7", "#34d399", "#60a5fa",
  "#f472b6", "#facc15", "#2dd4bf", "#c084fc", "#fca5a5",
];

const NODE_W = 16; // sankey node bar width — a clear grey column per token (Odos-style)
const PILL_H = 20; // label-pill height
// Gap between node rects. d3-sankey enforces this as the MINIMUM spacing, so it
// must exceed PILL_H or clustered nodes' pills overlap (the "bazard"/overlay on
// dense routes). PILL_H + 9 guarantees ~9px clearance even at minimum packing.
const NODE_PAD = PILL_H + 9;
const PILL_PAD_X = 8; // label-pill horizontal padding
const LABEL_FONT = 11;
const MIN_W = 240; // floor so a very narrow column still lays out
// Tall enough that the densest column never compresses below NODE_PAD (which
// would re-introduce overlap). Grows with node count; capped generously so even
// a ~17-node column stays clean.
const MAX_H = 880;
// Approximate rendered height of the hover tooltip (head + flow + via + pads) —
// used to decide when to flip it above the cursor near the scroll-box bottom.
const TIP_H = 72;
// Flows whose laid-out width is below this are dropped from the picture: a
// sub-pixel split (a 0.3 % leg, or a hop the venue reported with a 0-weight that
// floored to ~nothing) otherwise renders as a hairline that streaks diagonally
// across columns and reads as a stray line "between the junctions". Hiding them
// matches the way Odos only draws the flows that matter; the legend still lists
// every protocol, and the swap itself is unaffected.
const MIN_FLOW_PX = 2.5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Cheap label-width estimate (no DOM measuring): ~0.6em per char + padding.
function estLabelW(name: string): number {
  return Math.max(34, Math.ceil(name.length * LABEL_FONT * 0.6) + PILL_PAD_X * 2);
}

// `waypoint` nodes are the invisible relays inserted to break a multi-column
// link into adjacent-column segments — drawn as a colour-matched bridge
// (`color`) tagged with its owning link (`linkId`), no label (see buildModel).
type NodeData = {
  name: string;
  waypoint?: boolean;
  color?: string;
  linkId?: number;
};
type LinkData = {
  // Index of the ORIGINAL hop this segment belongs to. A multi-column link is
  // split into several segments that all share one linkId, so hover-highlight
  // and the tooltip treat the whole chain as one ribbon.
  linkId: number;
  exchange: string;
  color: string;
  value: number;
  sharePct: number;
  fromName: string;
  fromSym: string;
  toSym: string;
  humanIn: string | null;
  humanOut: string | null;
};

// Measure the container so the SVG can render at 1:1 (crisp text) and use the
// real available space instead of a fixed, down-scaled viewBox. Height is only
// consumed in fill mode (the modal), where the container has a definite height.
//
// Uses a CALLBACK ref, not an effect-captured ref: SankeySurface early-returns
// the trivial note before the ref'd wrap div exists, so on a trivial→graph
// transition (e.g. an async venue with no hops, then the user pins a sync venue
// on the same unkeyed instance) an effect-captured ref would have been null at
// mount and never re-attach — freezing width at the 360 default. A callback ref
// fires on every (un)mount of the node, so the observer always tracks the live
// div. Returns a node ref too, for the hover handler's getBoundingClientRect /
// scroll reads.
function useMeasuredSize(): readonly [
  (node: HTMLDivElement | null) => void,
  React.MutableRefObject<HTMLDivElement | null>,
  number,
  number,
] {
  const nodeRef = React.useRef<HTMLDivElement | null>(null);
  const roRef = React.useRef<ResizeObserver | null>(null);
  const [size, setSize] = React.useState<{ w: number; h: number }>({ w: 360, h: 0 });
  const setNode = React.useCallback((node: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    nodeRef.current = node;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width <= 0) return;
      // Use the REAL container width — never force MIN_W into the DOM size.
      // Flooring to MIN_W made the SVG wider than a narrow 1fr column, which
      // expanded the grid track and shoved center/right columns horizontally
      // on every re-measure (slider re-quotes).
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);
  return [setNode, nodeRef, size.w, size.h] as const;
}

export function RouteGraph({
  data,
  loading,
  intent,
}: {
  data: RouteGraphResponse | null;
  loading?: boolean;
  // The selected venue is an intent (async) one — settled off-chain by a
  // solver, so there is no on-chain route to draw. Show an "intent" note in
  // place of the sankey (and suppress "Show more").
  intent?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  // Stable so <RouteModal>'s Escape/scroll-lock effect doesn't tear down and
  // re-install on every parent re-render (the 1s expiry countdown re-renders
  // this subtree continuously while the modal is open).
  const closeModal = React.useCallback(() => setExpanded(false), []);

  // Only offer the modal when there is an actual multi-node graph to enlarge.
  // Probe the real layout (not just the hop filter): buildModel also collapses
  // to "trivial" when d3-sankey throws on a cyclic-by-symbol route, and we must
  // not show a "Show more" that opens a 90vw overlay holding only the
  // single-pool note. The probe width is nominal — `kind` is width-independent.
  const hasGraph = React.useMemo(
    () => !intent && !!data && buildModel(data, MIN_W).kind === "graph",
    [data, intent],
  );

  return (
    <div style={s.card}>
      <div style={s.head}>
        <span style={s.titleRow}>
          <span style={s.title}>Path</span>
          {/* Spin while path is loading / re-fetching. On venue switch the
              old sankey is cleared (data=null) so only the spinner + empty
              hint show; same-venue re-quotes keep the sticky graph. */}
          {loading && (
            <span role="status" aria-label="Loading path" style={{ display: "inline-flex" }}>
              <Icon
                name="spinner"
                size={14}
                style={{ color: "var(--text-tertiary)" }}
              />
            </span>
          )}
        </span>
        <span style={s.headRight}>
          {data && (
            <span style={s.via}>
              {data.tokenIn} → {data.tokenOut}
            </span>
          )}
          {hasGraph && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              style={s.showMore}
            >
              Show more
            </button>
          )}
        </span>
      </div>

      {intent ? (
        <div style={s.empty}>Off-chain intent — no on-chain route to display.</div>
      ) : (
        <>
          {loading && !data && <div style={s.empty}>Loading path…</div>}
          {data && <SankeySurface data={data} idPrefix="card" />}
        </>
      )}

      {expanded && data && !intent && (
        <RouteModal data={data} onClose={closeModal} />
      )}
    </div>
  );
}

// <RouteModal> — "Show more": the same sankey on a 90vw × 90vh overlay, so
// dense routes get real surface instead of the narrow card. Same overlay
// conventions as <TokenSelector> (backdrop click closes, inner click doesn't),
// plus Escape. The body scrolls if even the big surface can't fit the densest
// column without compressing below the anti-overlap minimum.
function RouteModal({
  data,
  onClose,
}: {
  data: RouteGraphResponse;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div style={s.overlay} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Route from ${data.tokenIn} to ${data.tokenOut}`}
        style={s.modal}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={s.modalHead}>
          <span style={s.title}>Path</span>
          <span style={s.via}>
            {data.tokenIn} → {data.tokenOut}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={s.closeBtn}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={s.modalBody}>
          <SankeySurface data={data} idPrefix="modal" fill />
        </div>
      </div>
    </div>
  );
}

// <SankeySurface> — measure → layout → render for one container. `fill` makes
// the layout stretch to the container's height (modal); otherwise the height is
// derived from the densest column (card). `idPrefix` namespaces the gradient
// defs: the card and the modal SVGs are mounted at the same time, and duplicate
// ids would make the modal's ribbons resolve to the card's userSpaceOnUse
// gradients (document-order first match) with the wrong coordinates.
function SankeySurface({
  data,
  idPrefix,
  fill,
}: {
  data: RouteGraphResponse;
  idPrefix: string;
  fill?: boolean;
}) {
  const [setWrap, wrapRef, width, height] = useMeasuredSize();
  const model = React.useMemo(
    // Floor layout width at MIN_W only for sankey math (readable labels), not
    // for the DOM — the SVG scales via viewBox into the real container width.
    () => buildModel(data, Math.max(MIN_W, width), fill ? height : undefined),
    [data, width, height, fill],
  );

  const [hover, setHover] = React.useState<{
    i: number;
    x: number;
    y: number;
    flipUp: boolean;
  } | null>(null);
  const [showAll, setShowAll] = React.useState(!!fill);

  // Reset hover/expansion whenever the route DATA changes (not just the
  // pair/venue): a same-pair price refresh rebuilds `model` with a possibly
  // different link count, and a stale `hover.i` would index a now-shorter
  // `model.links` (guarded against a crash, but it dims the wrong ribbon /
  // hides the tooltip until the next mouse move). `data` is a stable reference
  // between renders — the 1s expiry tick doesn't change it.
  React.useEffect(() => {
    setHover(null);
    setShowAll(!!fill);
  }, [data, fill]);

  const LEGEND_LIMIT = 8;

  if (model.kind === "trivial") {
    return (
      <div style={s.empty}>
        Direct {data.tokenIn} → {data.tokenOut} swap (single pool).
      </div>
    );
  }

  // Hover dimming is done by ONE background-coloured scrim composited over the
  // whole picture (plus a re-draw of the hovered link above it) — NOT by a
  // per-element opacity. Per-element dimming double-blends wherever geometry
  // overlaps: a waypoint bridge overhangs its segments by 0.5px on purpose (to
  // seal the junction seam when opaque), so two 18%-alpha layers stacked there
  // composited to ~33% and read as bright vertical hairlines at every relay
  // column. With the scrim, every ribbon/bridge/bar stays fully opaque and the
  // veil darkens the flattened result uniformly — no junction lines, no
  // brighter ribbon crossings.
  const hoveredLinkId = hover !== null ? model.links[hover.i]?.linkId : undefined;

  const hoverAt = (e: React.MouseEvent, i: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Absolute children sit in the (scrolled) padding box, so compensate the
    // fill-mode scroll offset (0 in the card). In fill mode the wrap is
    // `overflow:auto`, which clips a below-cursor tooltip near the visible
    // bottom — flip it above the cursor there. The card (overflow visible, no
    // scroll) keeps the below-cursor placement.
    const localY = e.clientY - r.top;
    const flipUp = !!fill && localY + TIP_H + 24 > el.clientHeight;
    setHover({
      i,
      x: e.clientX - r.left + el.scrollLeft,
      y: e.clientY - r.top + el.scrollTop,
      flipUp,
    });
  };

  const renderSeg = (
    l: (typeof model.links)[number],
    i: number,
    keyPrefix: string,
  ) => {
    const w = l.width ?? 0;
    if (w < MIN_FLOW_PX) return null; // drop hairline stray flows
    return (
      <path
        key={`${keyPrefix}-${i}`}
        d={model.linkPath(l) ?? undefined}
        stroke={`url(#rg-${idPrefix}-grad-${i})`}
        strokeWidth={w}
        strokeLinecap="butt"
      />
    );
  };

  const renderBridge = (n: (typeof model.nodes)[number], keyPrefix: string) => (
    <rect
      key={`${keyPrefix}-${n.name}`}
      x={(n.x0 ?? 0) - 0.5}
      y={n.y0 ?? 0}
      width={Math.max(1, (n.x1 ?? 0) - (n.x0 ?? 0)) + 1}
      height={Math.max(2, (n.y1 ?? 0) - (n.y0 ?? 0))}
      fill={n.color ?? "var(--ink-500)"}
    />
  );

  return (
    <>
      <div
        ref={setWrap}
        // Clear hover only when the pointer leaves the whole graph — NOT per
        // ribbon. The node bars / waypoint bridges occupy a NODE_W-wide strip in
        // every column with no ribbon hit-path under it, so a per-ribbon
        // onMouseLeave made the tooltip blink off each time the cursor crossed a
        // column. With the leave handler here, hover simply persists across those
        // strips (last ribbon) until a new ribbon updates it or you exit.
        onMouseLeave={() => setHover(null)}
        style={{
          position: "relative",
          width: "100%",
          // Fill mode: take exactly the available height (flex:1 with a 0%
          // basis is content-independent — no measure feedback loop) and
          // scroll the SVG inside, so the legend below never gets painted
          // over when even 90vh can't fit the densest column.
          ...(fill ? { flex: 1, minHeight: 0, overflow: "auto" } : {}),
        }}
      >
        <svg
          width="100%"
          height={model.height}
          viewBox={`0 0 ${model.width} ${model.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ display: "block" }}
          role="img"
          aria-label={`Route from ${data.tokenIn} to ${data.tokenOut}`}
        >
          <defs>
            {model.links.map((l, i) => {
              // userSpaceOnUse with explicit source→target x's: the link path
              // is a horizontal centerline (bbox height 0), so an
              // objectBoundingBox gradient would degenerate to invisible.
              const sx = (l.source as SankeyNode<NodeData, LinkData>).x1 ?? 0;
              const tx = (l.target as SankeyNode<NodeData, LinkData>).x0 ?? 0;
              return (
                <linearGradient
                  key={i}
                  id={`rg-${idPrefix}-grad-${i}`}
                  gradientUnits="userSpaceOnUse"
                  x1={sx}
                  y1={0}
                  x2={tx}
                  y2={0}
                >
                  {/* FLAT opacity (both stops equal): a per-segment falloff would
                      reset at every waypoint, so a split link's brightness would
                      oscillate column-to-column and read as a colour change on one
                      flow. Fully opaque also masks crossings cleanly (Odos-style)
                      and matches the waypoint bridge exactly (no seam). */}
                  <stop offset="0%" stopColor={l.color} stopOpacity={1} />
                  <stop offset="100%" stopColor={l.color} stopOpacity={1} />
                </linearGradient>
              );
            })}
          </defs>

          {/* ribbons — fully opaque, visuals only (hover hit-layer is on top) */}
          <g fill="none">{model.links.map((l, i) => renderSeg(l, i, "seg"))}</g>

          {/* node bars — grey token columns; waypoints are colour-matched bridges
              that carry the ribbon across the relay so the flow reads continuous.
              A node that only carries hidden hairline flow has ~no height — drop
              its bar/bridge so it doesn't leave a stray sliver at a column. */}
          {model.nodes.map((n) => {
            if ((n.y1 ?? 0) - (n.y0 ?? 0) < MIN_FLOW_PX) return null;
            if (n.waypoint) return renderBridge(n, "wp");
            const x0 = n.x0 ?? 0;
            const y0 = n.y0 ?? 0;
            return (
              <rect
                key={`bar-${n.name}`}
                x={x0}
                y={y0}
                width={Math.max(1, (n.x1 ?? 0) - x0)}
                height={Math.max(2, (n.y1 ?? 0) - y0)}
                rx={3}
                fill="var(--ink-500)"
                stroke="rgba(255,255,255,0.10)"
                strokeWidth={1}
              />
            );
          })}

          {/* hover scrim — darkens the whole flattened picture at once (bars
              included: a full-brightness grey column over a dimmed graph reads
              as a stray vertical line). Kept mounted at opacity 0 so the fade
              transitions both ways. */}
          <rect
            x={0}
            y={0}
            width={model.width}
            height={model.height}
            fill={fill ? "var(--surface-elevated)" : "var(--surface-raised)"}
            opacity={hover !== null ? 0.55 : 0}
            style={{ transition: "opacity 120ms ease", pointerEvents: "none" }}
          />

          {/* hovered link re-drawn above the scrim — every segment plus its
              waypoint bridges (they share one linkId), so the whole chain
              highlights as one continuous ribbon */}
          {hoveredLinkId !== undefined && (
            <g fill="none" style={{ pointerEvents: "none" }}>
              {model.links.map((l, i) =>
                l.linkId === hoveredLinkId ? renderSeg(l, i, "hl-seg") : null,
              )}
              {model.nodes.map((n) =>
                n.waypoint &&
                n.linkId === hoveredLinkId &&
                (n.y1 ?? 0) - (n.y0 ?? 0) >= MIN_FLOW_PX
                  ? renderBridge(n, "hl-wp")
                  : null,
              )}
            </g>
          )}

          {/* label pills — above the scrim, so they stay readable no matter how
              dense the flows are. Waypoints are routing relays, not tokens — no
              label. */}
          {model.nodes.map((n) => {
            if (n.waypoint) return null;
            // Skip the label of a node whose bar was dropped (hairline-only) so
            // it doesn't float without a column or any ribbon attached.
            if ((n.y1 ?? 0) - (n.y0 ?? 0) < MIN_FLOW_PX) return null;
            const x0 = n.x0 ?? 0;
            const x1 = n.x1 ?? 0;
            const cx = (x0 + x1) / 2;
            const cy = ((n.y0 ?? 0) + (n.y1 ?? 0)) / 2;
            const w = estLabelW(n.name);
            const left = clamp(cx - w / 2, 1, model.width - w - 1);
            return (
              // pointer-events:none — a label pill is far wider than its node and
              // overlaps nearby ribbon hit-paths; let the pointer reach the ribbon
              // underneath so hovering near a token doesn't drop the tooltip.
              <g key={`pill-${n.name}`} style={{ pointerEvents: "none" }}>
                <rect
                  x={left}
                  y={cy - PILL_H / 2}
                  width={w}
                  height={PILL_H}
                  rx={6}
                  fill="var(--ink-800)"
                  stroke="rgba(255,255,255,0.12)"
                />
                <text
                  x={left + w / 2}
                  y={cy}
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={s.nodeLabel}
                >
                  {n.name}
                </text>
              </g>
            );
          })}

          {/* hit layer — invisible fat strokes over the segments and rects over
              the waypoint bridges, on top of everything (pills are
              pointer-events:none). The bridges hover their own link so the
              tooltip doesn't vanish when the cursor crosses a relay column. */}
          <g fill="none">
            {model.links.map((l, i) => {
              const w = l.width ?? 0;
              if (w < MIN_FLOW_PX) return null;
              return (
                <path
                  key={`hit-${i}`}
                  d={model.linkPath(l) ?? undefined}
                  stroke="transparent"
                  strokeWidth={Math.max(w, 14)}
                  strokeLinecap="butt"
                  style={{ cursor: "pointer" }}
                  onMouseMove={(e) => hoverAt(e, i)}
                />
              );
            })}
            {model.nodes.map((n) => {
              if (!n.waypoint) return null;
              if ((n.y1 ?? 0) - (n.y0 ?? 0) < MIN_FLOW_PX) return null;
              return (
                <rect
                  key={`hit-wp-${n.name}`}
                  x={(n.x0 ?? 0) - 0.5}
                  y={n.y0 ?? 0}
                  width={Math.max(1, (n.x1 ?? 0) - (n.x0 ?? 0)) + 1}
                  height={Math.max(2, (n.y1 ?? 0) - (n.y0 ?? 0))}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseMove={(e) => {
                    const seg = model.links.findIndex(
                      (l) => l.linkId === n.linkId,
                    );
                    if (seg >= 0) hoverAt(e, seg);
                  }}
                />
              );
            })}
          </g>
        </svg>

        {hover && model.links[hover.i] && (
          <Tooltip
            link={model.links[hover.i]!}
            x={hover.x}
            y={hover.y}
            flipUp={hover.flipUp}
            width={model.width}
          />
        )}
      </div>

      <div style={s.legend}>
        {(showAll ? model.legend : model.legend.slice(0, LEGEND_LIMIT)).map((e) => (
          <span key={e.exchange} style={s.legendItem}>
            <span style={{ ...s.legendDot, background: e.color }} />
            {e.exchange}
          </span>
        ))}
        {model.legend.length > LEGEND_LIMIT && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            style={s.showAll}
          >
            {showAll ? "Show less" : `Show all (${model.legend.length})`}
          </button>
        )}
      </div>
    </>
  );
}

// Hover tooltip — protocol, source token + share %, humanised input amount.
function Tooltip({
  link,
  x,
  y,
  flipUp,
  width,
}: {
  link: LinkData;
  x: number;
  y: number;
  flipUp: boolean;
  width: number;
}) {
  // Flip to the left of the cursor when near the right edge so it never clips.
  const TIP_W = 260;
  const left = x + 14 + TIP_W > width ? x - 14 - TIP_W : x + 14;
  // Below the cursor by default; above it (flipUp) when the fill-mode scroll
  // box would clip a below-cursor tooltip at its visible bottom edge.
  const top = flipUp ? y - TIP_H - 12 : y + 12;
  return (
    <div style={{ ...s.tip, left: Math.max(0, left), top }}>
      <div style={s.tipHead}>
        <span style={{ ...s.tipDot, background: link.color }} />
        <span style={s.tipName}>{link.fromName}</span>
        <span style={s.tipPct}>{link.sharePct.toFixed(2)}%</span>
      </div>
      <div style={s.tipFlow}>
        {link.humanIn && <span style={s.tipAmt}>{link.humanIn} </span>}
        <span style={s.tipSym}>{link.fromSym}</span>
        <span style={s.tipArrow}> → </span>
        {link.humanOut && <span style={s.tipAmt}>{link.humanOut} </span>}
        <span style={s.tipSym}>{link.toSym}</span>
      </div>
      <div style={s.tipVia}>via {link.exchange}</div>
    </div>
  );
}

// ── layout model (d3-sankey) ────────────────────────────────────────────────

function buildModel(data: RouteGraphResponse, width: number, fillHeight?: number) {
  const W = Math.max(MIN_W, width);
  const hops: Hop[] = data.hops.filter((h) => h.from && h.to && h.from !== h.to);
  if (hops.length === 0) {
    return { kind: "trivial" as const };
  }

  const names = Array.from(new Set(hops.flatMap((h) => [h.from, h.to])));

  // ── Break cycles ───────────────────────────────────────────────────────────
  // Dense aggregator routes (kyber can return 50+ pool-level hops) revisit a
  // token symbol in both directions, so the symbol graph is cyclic and
  // d3-sankey throws "circular link" — which used to drop the whole route to the
  // trivial note. Remove DFS back-edges (the minority that close loops) to get a
  // DAG that lays out. Visit sources first so the edges we drop are the
  // loop-closers, not the route's spine.
  const adj = new Map<string, { to: string; idx: number }[]>();
  hops.forEach((h, idx) => {
    const a = adj.get(h.from);
    if (a) a.push({ to: h.to, idx });
    else adj.set(h.from, [{ to: h.to, idx }]);
  });
  const indeg = new Map<string, number>(names.map((n) => [n, 0]));
  for (const h of hops) indeg.set(h.to, (indeg.get(h.to) ?? 0) + 1);
  const startOrder = [...names.filter((n) => (indeg.get(n) ?? 0) === 0), ...names];
  const visit = new Map<string, 1 | 2>(); // 1 = on the active stack, 2 = done
  const keep = new Set<number>();
  const runDfs = (root: string) => {
    // Iterative DFS — routes can be deep; don't risk the call stack.
    const stack: { n: string; i: number }[] = [{ n: root, i: 0 }];
    visit.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const edges = adj.get(top.n) ?? [];
      if (top.i >= edges.length) {
        visit.set(top.n, 2);
        stack.pop();
        continue;
      }
      const e = edges[top.i++]!;
      const st = visit.get(e.to);
      if (st === 1) continue; // back-edge → drop (it closes a cycle)
      keep.add(e.idx);
      if (st === undefined) {
        visit.set(e.to, 1);
        stack.push({ n: e.to, i: 0 });
      }
    }
  };
  for (const n of startOrder) if (visit.get(n) === undefined) runDfs(n);
  const dagHops = keep.size === hops.length ? hops : hops.filter((_, i) => keep.has(i));
  if (dagHops.length === 0) return { kind: "trivial" as const };
  if (dagHops.length !== hops.length) {
    console.warn(
      `RouteGraph: dropped ${hops.length - dagHops.length} back-edge hop(s) to break a cycle for layout`,
    );
  }

  // Re-derive everything from the acyclic hop set.
  const dagNames = Array.from(new Set(dagHops.flatMap((h) => [h.from, h.to])));

  // Per-source share by tokenIn base-units routed through each hop.
  const outTotal = new Map<string, number>();
  const outCount = new Map<string, number>();
  for (const h of dagHops) {
    outTotal.set(h.from, (outTotal.get(h.from) ?? 0) + safeNum(h.swapAmount));
    outCount.set(h.from, (outCount.get(h.from) ?? 0) + 1);
  }

  // Longest-path depth — well-defined now the graph is acyclic. Every edge then
  // satisfies depth(to) ≥ depth(from)+1, so the layered split below is exact.
  const depth = new Map<string, number>(dagNames.map((n) => [n, 0]));
  for (let i = 0; i < dagNames.length; i++) {
    for (const h of dagHops) {
      depth.set(h.to, Math.max(depth.get(h.to)!, depth.get(h.from)! + 1));
    }
  }
  const incoming = new Set(dagHops.map((h) => h.to));
  const flow = new Map<string, number>(
    dagNames.map((n) => [n, incoming.has(n) ? 0 : 1]),
  );
  const ordered = [...dagNames].sort((a, b) => depth.get(a)! - depth.get(b)!);

  // Colour per protocol (only the protocols that survive into the layout).
  const exchanges = Array.from(new Set(dagHops.map((h) => h.exchange)));
  const colorOf = new Map(
    exchanges.map((ex, i) => [ex, PALETTE[i % PALETTE.length]!]),
  );

  // One link per kept hop, with a conserved flow value (so widths are comparable
  // across tokens). linkId ties the segments of a split link back together.
  const links = dagHops.map((h, linkId) => {
    const total = outTotal.get(h.from) ?? 0;
    const share =
      total > 0 ? safeNum(h.swapAmount) / total : 1 / (outCount.get(h.from) ?? 1);
    const humanIn =
      !h.approxAmount && Number.isFinite(h.fromDecimals)
        ? formatUnits(h.swapAmount, h.fromDecimals, 6)
        : null;
    const humanOut =
      h.amountOut && Number.isFinite(h.toDecimals)
        ? formatUnits(h.amountOut, h.toDecimals, 6)
        : null;
    return {
      linkId,
      source: h.from,
      target: h.to,
      _share: share,
      value: 0,
      exchange: h.exchange,
      color: colorOf.get(h.exchange)!,
      sharePct: share * 100,
      fromName: h.fromName,
      fromSym: h.from,
      toSym: h.to,
      humanIn,
      humanOut,
    };
  });
  for (const n of ordered) {
    const f = flow.get(n) ?? 0;
    for (const l of links) {
      if (l.source !== n) continue;
      l.value = Math.max(l._share * f, 1e-6);
      flow.set(l.target, (flow.get(l.target) ?? 0) + l.value);
    }
  }

  // ── Layered expansion ───────────────────────────────────────────────────────
  // d3-sankey draws a link whose endpoints are >1 column apart as one long curve
  // OVER the intervening column(s) — the "overpass" band on routes that have a
  // direct hop alongside a multi-hop one (Odos avoids this entirely). Split every
  // such link into a chain of adjacent-column segments through invisible waypoint
  // nodes; each waypoint is drawn as a colour-matched bridge so the ribbon reads
  // as one continuous band.
  type Seg = LinkData & { source: string; target: string };
  const segments: Seg[] = [];
  const wpDepth = new Map<string, number>();
  const wpColorOf = new Map<string, string>();
  const wpLinkOf = new Map<string, number>();
  for (const l of links) {
    const ld: LinkData = {
      linkId: l.linkId,
      exchange: l.exchange,
      color: l.color,
      value: l.value,
      sharePct: l.sharePct,
      fromName: l.fromName,
      fromSym: l.fromSym,
      toSym: l.toSym,
      humanIn: l.humanIn,
      humanOut: l.humanOut,
    };
    const ds = depth.get(l.source)!;
    const dt = depth.get(l.target)!;
    if (dt - ds <= 1) {
      segments.push({ ...ld, source: l.source, target: l.target });
      continue;
    }
    let prev = l.source;
    for (let d = ds + 1; d < dt; d++) {
      const wp = ` wp:${l.linkId}:${d}`; // NUL prefix can't collide with a token symbol
      wpDepth.set(wp, d);
      wpColorOf.set(wp, l.color);
      wpLinkOf.set(wp, l.linkId);
      segments.push({ ...ld, source: prev, target: wp });
      prev = wp;
    }
    segments.push({ ...ld, source: prev, target: l.target });
  }

  const allNodes: NodeData[] = [
    ...dagNames.map((name) => ({ name })),
    ...[...wpDepth.keys()].map((name) => ({
      name,
      waypoint: true,
      color: wpColorOf.get(name),
      linkId: wpLinkOf.get(name),
    })),
  ];

  // Column counts INCLUDING waypoints, so the height leaves room for d3-sankey's
  // per-node padding even in columns where relays were inserted.
  const colCount = new Map<number, number>();
  for (const n of dagNames)
    colCount.set(depth.get(n)!, (colCount.get(depth.get(n)!) ?? 0) + 1);
  for (const d of wpDepth.values()) colCount.set(d, (colCount.get(d) ?? 0) + 1);
  const maxCol = Math.max(1, ...colCount.values());

  // Enough vertical room that each node's label pill clears its neighbours —
  // sized so d3-sankey never has to compress a column below NODE_PAD.
  const minNeeded = maxCol * (PILL_H + NODE_PAD) + 16;
  // Card: densest-column height, capped at MAX_H. Fill (modal): stretch to the
  // measured container so the route actually uses the big surface — never below
  // the anti-overlap minimum (body scrolls instead), and capped at 3× so a
  // two-node route doesn't become one giant ribbon.
  const height = fillHeight
    ? Math.max(minNeeded, Math.min(fillHeight, Math.max(minNeeded * 3, 560)))
    : clamp(minNeeded, 200, MAX_H);

  let graph: SankeyGraph<NodeData, LinkData>;
  try {
    const gen = sankey<NodeData, LinkData>()
      .nodeId((dn) => dn.name)
      .nodeAlign(sankeyLeft) // columns = longest-path depth, so waypoints land right
      .nodeWidth(NODE_W)
      .nodePadding(NODE_PAD)
      .extent([
        [1, PILL_H / 2 + 2],
        [W - 1, height - PILL_H / 2 - 2],
      ]);
    graph = gen({
      nodes: allNodes.map((n) => ({ ...n })),
      links: segments.map((l) => ({
        source: l.source,
        target: l.target,
        value: l.value,
        linkId: l.linkId,
        exchange: l.exchange,
        color: l.color,
        sharePct: l.sharePct,
        fromName: l.fromName,
        fromSym: l.fromSym,
        toSym: l.toSym,
        humanIn: l.humanIn,
        humanOut: l.humanOut,
      })),
    });
  } catch (e) {
    // Should not happen now the graph is acyclic + layered, but never crash the
    // panel — fall back to the trivial note and say why.
    console.warn("RouteGraph: sankey layout failed, showing trivial note", e);
    return { kind: "trivial" as const };
  }

  const linkPathGen = sankeyLinkHorizontal<NodeData, LinkData>();
  const linkPath = (l: SankeyLink<NodeData, LinkData>) => linkPathGen(l);
  const legend = exchanges.map((ex) => ({ exchange: ex, color: colorOf.get(ex)! }));

  return {
    kind: "graph" as const,
    width: W,
    height,
    nodes: graph.nodes as SankeyNode<NodeData, LinkData>[],
    links: graph.links as (SankeyLink<NodeData, LinkData> & LinkData)[],
    linkPath,
    legend,
  };
}

// Number() of a base-units string; huge values lose precision but the ratios we
// use for widths are unaffected. Non-numeric → 0.
function safeNum(str: string): number {
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

const s: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--surface-raised)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    padding: 18,
    // Stay inside the left 1fr track; SVG/legend must not widen the column.
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    overflow: "hidden",
    minWidth: 0,
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  headRight: {
    display: "flex",
    alignItems: "baseline",
    gap: 12,
  },
  titleRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontFamily: "var(--font-display)",
    fontSize: 17,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
  via: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-tertiary)",
  },
  empty: {
    padding: "10px 2px",
    fontSize: 13,
    color: "var(--text-tertiary)",
  },
  showMore: {
    border: "none",
    background: "transparent",
    color: "var(--brand-orange)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
  },
  nodeLabel: {
    fontFamily: "var(--font-sans)",
    fontSize: LABEL_FONT,
    fontWeight: 700,
    fill: "var(--text-strong)",
  } as React.CSSProperties,
  legend: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px 16px",
    marginTop: 16,
    paddingTop: 12,
    borderTop: "1px solid var(--border-subtle)",
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12,
    color: "var(--text-secondary)",
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 3,
    flex: "none",
  },
  showAll: {
    marginLeft: "auto",
    border: "none",
    background: "transparent",
    color: "var(--brand-orange)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    padding: 0,
  },
  // ── "Show more" modal (same overlay conventions as <TokenSelector>) ──
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
  },
  modal: {
    width: "90vw",
    height: "90vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-2xl)",
    boxShadow: "var(--shadow-xl)",
    padding: 22,
    boxSizing: "border-box",
  },
  modalHead: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  closeBtn: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    flex: "none",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-frost)",
    color: "var(--text-tertiary)",
    cursor: "pointer",
  },
  modalBody: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "auto",
  },
  // ── hover tooltip ──
  tip: {
    position: "absolute",
    zIndex: 5,
    pointerEvents: "none",
    minWidth: 150,
    maxWidth: 260,
    padding: "9px 11px",
    background: "var(--ink-800)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-lg)",
  },
  tipHead: {
    display: "flex",
    alignItems: "center",
    gap: 7,
  },
  tipDot: {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flex: "none",
  },
  tipName: {
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  tipPct: {
    marginLeft: "auto",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    fontWeight: 700,
    color: "var(--text-secondary)",
    fontFeatureSettings: '"tnum" 1',
  },
  tipFlow: {
    marginTop: 6,
    fontSize: 11,
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  },
  tipAmt: {
    fontFamily: "var(--font-mono)",
    color: "var(--text-strong)",
    fontWeight: 700,
    fontFeatureSettings: '"tnum" 1',
  },
  tipSym: { fontWeight: 700, color: "var(--text-strong)" },
  tipArrow: { color: "var(--text-tertiary)" },
  tipVia: {
    marginTop: 5,
    fontSize: 11,
    color: "var(--text-secondary)",
  },
};

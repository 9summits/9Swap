import React from "react";
import { Badge } from "../ds/components/Badge";
import { Icon } from "./icons";

// The header's "No tracking" pill: a Badge linking to the disclaimer's Privacy
// section, with an inline "i" glyph advertising that there is more to read.
// The tooltip is custom rather than a native `title` — the browser's own bubble
// waits ~1s and renders unstyled plain text, which reads as a bug next to the
// rest of the dApp chrome. Anchor: /disclaimer.html#privacy ("03 Privacy").

// Anchor of the "03 Privacy" section inside the disclaimer page (same origin).
const PRIVACY_URL = "/disclaimer.html#privacy";
// id wiring the tooltip to the link for screen readers (aria-describedby).
const TIP_ID = "privacy-pill-tip";
// What the pill actually promises, one check per item.
const PLEDGES = [
  "No accounts",
  "No cookies",
  "No trackers",
  "No analytics",
  "No advertising",
  "No data collection",
] as const;

const TIP_CSS = `@keyframes swaggPrivacyTipIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}`;

export function PrivacyPill() {
  const [open, setOpen] = React.useState(false);

  return (
    <span
      style={s.wrap}
      data-privacy-pill
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <style>{TIP_CSS}</style>
      <a
        href={PRIVACY_URL}
        aria-label="No tracking — read the privacy notice"
        aria-describedby={open ? TIP_ID : undefined}
        style={s.link}
      >
        <Badge tone="neutral" variant="soft" size="sm">
          No tracking
          <Icon name="info" size={11} style={s.infoIcon} />
        </Badge>
      </a>
      {open && (
        <div id={TIP_ID} role="tooltip" style={s.tip}>
          <div style={s.tipTitle}>
            <Icon name="info" size={12} style={{ color: "var(--text-link)", flex: "none" }} />
            No tracking
          </div>
          <div style={s.grid}>
            {PLEDGES.map((p) => (
              <div key={p} style={s.item}>
                <Icon name="check" size={11} style={{ color: "var(--positive)", flex: "none" }} />
                {p}
              </div>
            ))}
          </div>
          <div style={s.foot}>Click for the full privacy notice</div>
        </div>
      )}
    </span>
  );
}

/* --------------------------------- styles --------------------------------- */
const s: Record<string, React.CSSProperties> = {
  wrap: { position: "relative", display: "inline-flex" },
  link: {
    display: "inline-flex",
    textDecoration: "none",
    color: "inherit",
    borderRadius: "var(--radius-pill)",
  },
  // Inherits the badge's text color (Icon strokes with currentColor).
  infoIcon: { flex: "none", opacity: 0.8, marginLeft: 1 },
  tip: {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: 0,
    zIndex: 5,
    width: 290,
    padding: "10px 12px 10px",
    borderRadius: 10,
    border: "1px solid var(--border-default)",
    background: "var(--ink-850, #16131f)",
    boxShadow: "var(--shadow-md)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    pointerEvents: "none",
    animation: "swaggPrivacyTipIn 140ms ease-out",
    textAlign: "left",
    whiteSpace: "normal",
  },
  tipTitle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
    fontWeight: 700,
    color: "var(--text-strong)",
  },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 10px" },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontWeight: 600,
    color: "var(--text-primary)",
  },
  foot: {
    marginTop: 9,
    paddingTop: 8,
    borderTop: "1px solid var(--border-subtle)",
    fontSize: 11,
    fontWeight: 500,
    color: "var(--text-tertiary)",
  },
};

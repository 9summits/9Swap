import React from "react";
import { Button } from "../ds/components/Button";
import { Switch } from "../ds/components/Switch";
import { Icon } from "./icons";
import { vmeta } from "./venues";
import { listAllCustomTokens } from "./customTokens";
import { CustomTokensModal } from "./CustomTokensModal";
import type { SettingsPopoverProps, VenueMeta } from "./types";

// <SettingsPopover> — the swap card's settings control. Renders a settings-gear
// trigger that opens an anchored, dark, brand-consistent panel with:
//   · venue filters — one Switch per venue (from `venues`), toggling membership
//     in `enabledVenues` via `onToggleVenue`.
//   · Copy CLI — extra flags on the copied `swap …` command (--json, -d, --simu).
//   · custom tokens — always-visible count (all chains) + Manage, which
//     opens CustomTokensModal and closes this popover.
// Slippage is NOT here (it lives on the swap card's "Max slippage" row), and the
// "Include intent venues" toggle now lives in the RoutesPane header.
//
// Self-contained: owns its open/closed state and dismiss-on-outside-click. The
// settings state itself is fully controlled via SettingsPopoverProps.

export function SettingsPopover({
  venues,
  enabledVenues,
  onToggleVenue,
  onSetAllVenues,
  allowAsync,
  cliJson,
  onCliJson,
  cliData,
  onCliData,
  cliSimu,
  onCliSimu,
  chain,
}: SettingsPopoverProps) {
  // "All / none" button state: are every venue currently enabled?
  const allEnabled =
    venues.length > 0 && venues.every((v) => enabledVenues.includes(v.name));
  // A venue is effectively active only if it's enabled AND, for intent (async)
  // venues, the global Intent toggle is on. Mirror that here so the list and the
  // count never show an intent venue as "on" while Intent is off.
  const isGatedOff = (v: VenueMeta) => v.kind === "async" && !allowAsync;
  const effectiveOnCount = venues.filter(
    (v) => enabledVenues.includes(v.name) && !isGatedOff(v),
  ).length;
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // All-chain custom-token count, re-read each open (TokenSelector / the
  // manager modal may have mutated localStorage since).
  const [customCount, setCustomCount] = React.useState(0);
  const [manageOpen, setManageOpen] = React.useState(false);
  React.useEffect(() => {
    if (open) setCustomCount(listAllCustomTokens().length);
  }, [open]);

  // Dismiss on outside click + Escape, only while open.
  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <div ref={rootRef} style={s.root}>
      <button
        type="button"
        aria-label="Swap settings"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...s.trigger,
          ...(open ? s.triggerOn : null),
        }}
        onMouseEnter={(e) => {
          if (!open)
            e.currentTarget.style.background = "var(--surface-frost-strong)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "var(--surface-frost)";
        }}
      >
        <Icon name="settings" size={16} />
      </button>

      {open && (
        <div style={s.panel} role="dialog" aria-label="Swap settings">
          {/* ---- Venue filters ---- */}
          <section style={s.section}>
            <div style={s.sectionHead}>
              <span style={s.sectionTitle}>Venues</span>
              <span style={s.sectionRight}>
                <span style={s.sectionMeta}>
                  {effectiveOnCount}/{venues.length} on
                </span>
                <button
                  type="button"
                  style={s.allBtn}
                  onClick={() => onSetAllVenues(!allEnabled)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--text-strong)";
                    e.currentTarget.style.borderColor = "var(--border-brand)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-secondary)";
                    e.currentTarget.style.borderColor = "var(--border-default)";
                  }}
                >
                  {allEnabled ? "Disable all" : "Enable all"}
                </button>
              </span>
            </div>
            <div style={s.venueList}>
              {venues.map((v) => {
                const meta = vmeta(v.name);
                // Globally gated off (intent venue while Intent is off): force
                // the row to read off + disabled so it can't appear active while
                // the Intent toggle in the Routes header is off.
                const gatedOff = isGatedOff(v);
                const on = enabledVenues.includes(v.name) && !gatedOff;
                // The WHOLE row is the toggle: a single role="switch" control.
                // The <Switch> inside is presentational (interactive={false}) so
                // we don't nest a <button> in a <button> — that's invalid HTML and
                // double-fires onToggleVenue (toggle + bubble), which is why
                // clicking the switch appeared to do nothing.
                const toggle = () => {
                  if (gatedOff) return;
                  onToggleVenue(v.name);
                };
                return (
                  <div
                    key={v.name}
                    role="switch"
                    aria-checked={on}
                    aria-disabled={gatedOff || undefined}
                    aria-label={meta.label}
                    tabIndex={gatedOff ? -1 : 0}
                    onClick={toggle}
                    onKeyDown={(e) => {
                      if (!gatedOff && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        toggle();
                      }
                    }}
                    title={
                      gatedOff
                        ? "Turn on Intent (Routes panel) to use async venues"
                        : undefined
                    }
                    style={{ ...s.venueRow, ...(gatedOff ? s.venueRowGated : null) }}
                    onMouseEnter={(e) => {
                      if (!gatedOff)
                        e.currentTarget.style.background = "var(--surface-frost)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={s.venueLeft}>
                      <span
                        style={{ ...s.venueDot, background: meta.tint }}
                        aria-hidden="true"
                      />
                      <span style={s.venueLabel}>{meta.label}</span>
                      {v.kind === "async" && (
                        <span style={s.intentTag}>intent</span>
                      )}
                    </span>
                    <Switch checked={on} interactive={false} size="sm" />
                  </div>
                );
              })}
            </div>
          </section>

          {/* ---- Copy CLI extras ---- */}
          <div style={s.divider} />
          <section style={s.section}>
            <div style={s.sectionHead}>
              <span style={s.sectionTitle}>Copy CLI</span>
            </div>
            <div style={s.venueList}>
              <div
                role="switch"
                aria-checked={cliJson}
                aria-label="JSON output"
                tabIndex={0}
                title="Print JSON (CLI --json)"
                onClick={() => onCliJson(!cliJson)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCliJson(!cliJson);
                  }
                }}
                style={s.venueRow}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--surface-frost)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={s.advancedLeft}>
                  <span style={s.venueLabel}>JSON output</span>
                  <span style={s.advancedHint}>CLI --json</span>
                </span>
                <Switch checked={cliJson} interactive={false} size="sm" />
              </div>
              <div
                role="switch"
                aria-checked={cliData}
                aria-label="Build calldata"
                tabIndex={0}
                title="Include swap tx calldata (CLI -d). Simulate forces this on."
                onClick={() => onCliData(!cliData)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCliData(!cliData);
                  }
                }}
                style={s.venueRow}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--surface-frost)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={s.advancedLeft}>
                  <span style={s.venueLabel}>Build calldata</span>
                  <span style={s.advancedHint}>CLI -d (--data)</span>
                </span>
                <Switch checked={cliData} interactive={false} size="sm" />
              </div>
              <div
                role="switch"
                aria-checked={cliSimu}
                aria-label="Simulate"
                tabIndex={0}
                title="Simulate the built tx via eth_simulateV1 (CLI --simu). Implies -d."
                onClick={() => onCliSimu(!cliSimu)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCliSimu(!cliSimu);
                  }
                }}
                style={s.venueRow}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--surface-frost)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <span style={s.advancedLeft}>
                  <span style={s.venueLabel}>Simulate</span>
                  <span style={s.advancedHint}>CLI --simu (implies -d)</span>
                </span>
                <Switch checked={cliSimu} interactive={false} size="sm" />
              </div>
            </div>
          </section>

          {/* ---- Custom tokens (all chains, localStorage) ---- */}
          <div style={s.divider} />
          <section style={s.section}>
            <div style={s.sectionHead}>
              <span style={s.sectionTitle}>Custom tokens</span>
              <span style={s.sectionMeta}>{customCount}</span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              onClick={() => {
                setOpen(false);
                setManageOpen(true);
              }}
            >
              Manage
            </Button>
          </section>

          <div style={s.footer}>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              onClick={() => setOpen(false)}
            >
              Done
            </Button>
          </div>
        </div>
      )}
      </div>
      <CustomTokensModal
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          setCustomCount(listAllCustomTokens().length);
        }}
        defaultChainId={chain.chainId}
      />
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { position: "relative", display: "inline-flex", flex: "none" },

  trigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    flex: "none",
    // Override the legacy page's global `button` padding (web/index.html),
    // which would clamp the fixed 34px width to padding+border=38px.
    padding: 0,
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-frost)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition:
      "background var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out)",
  },
  triggerOn: {
    background: "var(--brand-soft)",
    borderColor: "var(--border-brand)",
    color: "var(--text-strong)",
  },

  panel: {
    position: "absolute",
    top: "calc(100% + 10px)",
    right: 0,
    zIndex: 50,
    width: 320,
    maxWidth: "calc(100vw - 32px)",
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-xl), var(--shadow-inset)",
    padding: 16,
    fontFamily: "var(--font-sans)",
  },

  section: { display: "flex", flexDirection: "column", gap: 10 },
  sectionHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    fontFamily: "var(--font-display)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
  sectionRight: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
  },
  sectionMeta: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-tertiary)",
    fontFeatureSettings: '"tnum" 1',
  },
  allBtn: {
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-secondary)",
    background: "transparent",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-pill)",
    padding: "2px 10px",
    cursor: "pointer",
    transition:
      "color var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out)",
  },

  divider: {
    height: 1,
    background: "var(--border-subtle)",
    margin: "14px 0",
  },

  venueList: { display: "flex", flexDirection: "column", gap: 2 },
  venueRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "7px 8px",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    cursor: "pointer",
    width: "100%",
    textAlign: "left",
    transition: "background var(--dur-base) var(--ease-out)",
  },
  venueRowGated: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  venueLeft: {
    display: "inline-flex",
    alignItems: "center",
    gap: 9,
    minWidth: 0,
  },
  venueDot: {
    width: 9,
    height: 9,
    borderRadius: "50%",
    flex: "none",
    boxShadow: "var(--shadow-inset)",
  },
  venueLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  advancedLeft: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  advancedHint: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    lineHeight: 1.3,
  },
  intentTag: {
    flex: "none",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    padding: "1px 6px",
    borderRadius: "var(--radius-pill)",
    background: "var(--surface-frost)",
  },

  footer: { marginTop: 16 },
};

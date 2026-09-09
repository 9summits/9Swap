import React from "react";

// 9Summits Switch — on/off toggle. On state fills with the brand gradient.
// Controlled via `checked` + `onChange(next)`. Ported from the design system's
// Switch.jsx (prop API kept identical).

export type SwitchSize = "sm" | "md";

export type SwitchProps = {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  size?: SwitchSize;
  label?: React.ReactNode;
  id?: string;
  style?: React.CSSProperties;
  /**
   * Presentational mode: render the track/knob as a decorative <span> instead of
   * an interactive <button role="switch">. Use when the switch lives inside an
   * already-interactive control (e.g. a clickable settings row) — nesting a
   * button inside a button is invalid HTML and double-fires the toggle.
   */
  interactive?: boolean;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "disabled" | "type" | "style" | "id"
>;

export function Switch({
  checked = false,
  onChange,
  disabled = false,
  size = "md",
  label = null,
  id,
  style = {},
  interactive = true,
  ...rest
}: SwitchProps) {
  const sizes: Record<SwitchSize, { w: number; h: number; knob: number }> = {
    sm: { w: 36, h: 20, knob: 14 },
    md: { w: 46, h: 26, knob: 20 },
  };
  const s = sizes[size] || sizes.md;
  const pad = (s.h - s.knob) / 2;

  const track: React.CSSProperties = {
    position: "relative",
    width: s.w,
    height: s.h,
    flex: "none",
    borderRadius: "var(--radius-pill)",
    background: checked ? "var(--gradient-brand)" : "var(--ink-700)",
    boxShadow: checked
      ? "var(--shadow-brand-sm)"
      : "inset 0 1px 2px rgba(0,0,0,0.4)",
    transition:
      "background var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    border: "none",
    padding: 0,
  };
  const knob: React.CSSProperties = {
    position: "absolute",
    top: pad,
    left: checked ? s.w - s.knob - pad : pad,
    width: s.knob,
    height: s.knob,
    borderRadius: "50%",
    background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
    transition: "left var(--dur-base) var(--ease-spring)",
  };

  const el = interactive ? (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      onClick={() => !disabled && onChange && onChange(!checked)}
      style={track}
      {...rest}
    >
      <span style={knob} />
    </button>
  ) : (
    // Decorative only — the surrounding control owns the interaction + a11y.
    // display:inline-block is required: a bare <span> is display:inline, which
    // ignores width/height, collapsing the track to nothing and leaving only the
    // absolutely-positioned knob visible (a stray white dot).
    <span
      style={{ ...track, display: "inline-block", cursor: "inherit" }}
      aria-hidden="true"
    >
      <span style={knob} />
    </span>
  );

  if (!label) return <span style={style}>{el}</span>;
  return (
    <label
      htmlFor={id}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-3)",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--weight-medium)" as unknown as number,
        color: "var(--text-primary)",
        ...style,
      }}
    >
      {el}
      {label}
    </label>
  );
}

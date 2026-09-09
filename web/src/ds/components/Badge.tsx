import React from "react";

// 9Summits Badge — compact status / metric pill. Tones map to the finance
// semantics (positive APR, paused, new, etc). `dot` shows a leading status dot.
// Ported from the design system's Badge.jsx (prop API kept identical).

export type BadgeTone =
  | "neutral"
  | "brand"
  | "positive"
  | "negative"
  | "warning"
  | "info";
export type BadgeVariant = "soft" | "solid" | "outline";
export type BadgeSize = "sm" | "md";

export type BadgeProps = {
  children?: React.ReactNode;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "style" | "children">;

export function Badge({
  children,
  tone = "neutral",
  variant = "soft",
  size = "md",
  dot = false,
  style = {},
  ...rest
}: BadgeProps) {
  const tones: Record<
    BadgeTone,
    { fg: string; soft: string; solid: string; solidFg: string }
  > = {
    neutral: {
      fg: "var(--text-secondary)",
      soft: "var(--surface-frost-strong)",
      solid: "var(--ink-700)",
      solidFg: "var(--text-strong)",
    },
    brand: {
      fg: "var(--text-link)",
      soft: "var(--brand-soft)",
      solid: "var(--brand-solid)",
      solidFg: "#fff",
    },
    positive: {
      fg: "var(--positive)",
      soft: "var(--positive-bg)",
      solid: "var(--positive)",
      solidFg: "#04150d",
    },
    negative: {
      fg: "var(--negative)",
      soft: "var(--negative-bg)",
      solid: "var(--negative)",
      solidFg: "#1a0306",
    },
    warning: {
      fg: "var(--warning)",
      soft: "var(--warning-bg)",
      solid: "var(--warning)",
      solidFg: "#1f1403",
    },
    info: {
      fg: "var(--info)",
      soft: "var(--info-bg)",
      solid: "var(--info)",
      solidFg: "#031021",
    },
  };
  const t = tones[tone] || tones.neutral;
  const sizes: Record<
    BadgeSize,
    { fontSize: number; padding: string; gap: number; dotSize: number }
  > = {
    sm: { fontSize: 11, padding: dot ? "2px 8px 2px 7px" : "2px 8px", gap: 5, dotSize: 5 },
    md: { fontSize: 12, padding: dot ? "4px 10px 4px 9px" : "3px 10px", gap: 6, dotSize: 6 },
  };
  const s = sizes[size] || sizes.md;
  const isSolid = variant === "solid";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: s.gap,
        padding: s.padding,
        fontFamily: "var(--font-sans)",
        fontSize: s.fontSize,
        fontWeight: "var(--weight-bold)" as unknown as number,
        lineHeight: 1.4,
        letterSpacing: "0.01em",
        borderRadius: "var(--radius-pill)",
        background: isSolid ? t.solid : t.soft,
        color: isSolid ? t.solidFg : t.fg,
        border: variant === "outline" ? `1px solid ${t.fg}` : "1px solid transparent",
        whiteSpace: "nowrap",
        ...style,
      }}
      {...rest}
    >
      {dot && (
        <span
          style={{
            width: s.dotSize,
            height: s.dotSize,
            borderRadius: "50%",
            background: isSolid ? t.solidFg : t.fg,
            flex: "none",
          }}
        />
      )}
      {children}
    </span>
  );
}

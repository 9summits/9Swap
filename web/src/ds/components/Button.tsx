import React from "react";

// 9Summits Button — the primary action control. Ported from the design
// system's Button.jsx (prop API kept identical: variant / size / fullWidth /
// loading / disabled / leftIcon / rightIcon). Signature variant is the brand
// gradient fill with a magenta bloom.

export type ButtonVariant =
  | "primary"
  | "solid"
  | "secondary"
  | "ghost"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  type?: "button" | "submit" | "reset";
  href?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  style?: React.CSSProperties;
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "onClick" | "style" | "children" | "href"
>;

export function Button({
  children,
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  disabled = false,
  leftIcon = null,
  rightIcon = null,
  type = "button",
  href,
  onClick,
  style = {},
  className,
  ...rest
}: ButtonProps) {
  const sizes: Record<
    ButtonSize,
    { height: number; padding: string; fontSize: number; gap: number; radius: string }
  > = {
    sm: { height: 34, padding: "0 14px", fontSize: 13, gap: 7, radius: "var(--radius-md)" },
    md: { height: 42, padding: "0 18px", fontSize: 14, gap: 8, radius: "var(--radius-md)" },
    lg: { height: 52, padding: "0 26px", fontSize: 16, gap: 10, radius: "var(--radius-lg)" },
  };
  const s = sizes[size] || sizes.md;

  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: s.gap,
    height: s.height,
    padding: s.padding,
    width: fullWidth ? "100%" : "auto",
    fontFamily: "var(--font-sans)",
    fontSize: s.fontSize,
    fontWeight: "var(--weight-bold)" as unknown as number,
    lineHeight: 1,
    letterSpacing: "-0.005em",
    borderRadius: s.radius,
    border: "1px solid transparent",
    // Clip the (gradient) background to the padding box, NOT the border box.
    // With a 1px transparent border + border-radius, a border-box clip lets the
    // gradient bleed into the transparent border and anti-alias to a pale fringe
    // around the button (very visible on Retina/2x) — the "degeu" outline.
    // padding-box keeps the fill strictly inside the border, so the edge is clean.
    backgroundClip: "padding-box",
    cursor: disabled || loading ? "not-allowed" : "pointer",
    transition:
      "transform var(--dur-fast) var(--ease-out), background var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out)",
    whiteSpace: "nowrap",
    userSelect: "none",
    opacity: disabled ? 0.45 : 1,
  };

  // Use background LONGHANDS (backgroundImage / backgroundColor) — never the
  // `background` shorthand. The shorthand resets `background-clip` to its initial
  // (border-box) every time it's set, which would undo the padding-box clip in
  // `base` and bring back the pale Retina edge fringe.
  const variants: Record<ButtonVariant, React.CSSProperties> = {
    primary: {
      backgroundImage: "var(--gradient-brand)",
      color: "var(--text-on-brand)",
      // No resting bloom — the magenta glow only blooms on hover (handleEnter),
      // so the idle button reads clean instead of haloed.
    },
    solid: {
      backgroundColor: "var(--brand-solid)",
      color: "var(--text-on-brand)",
    },
    secondary: {
      backgroundColor: "var(--surface-frost)",
      color: "var(--text-strong)",
      borderColor: "var(--border-default)",
    },
    ghost: {
      backgroundColor: "transparent",
      color: "var(--text-secondary)",
    },
    danger: {
      backgroundColor: "var(--negative)",
      color: "#1a0306",
    },
  };

  const v = variants[variant] || variants.primary;

  // Disabled visual: the vivid-fill variants (primary gradient / solid / danger)
  // must NOT be rendered as a dimmed vivid fill — at opacity 0.45 the brand
  // gradient leaves a saturated magenta block on the right edge that reads as a
  // stray overlay. Flatten them to a muted, intentionally-disabled surface
  // instead. Subtle variants (secondary/ghost) keep the simple opacity dim.
  const vivid = variant === "primary" || variant === "solid" || variant === "danger";
  const disabledVisual: React.CSSProperties =
    disabled && !loading && vivid
      ? {
          backgroundImage: "none",
          backgroundColor: "var(--surface-frost-strong)",
          color: "var(--text-tertiary)",
          borderColor: "var(--border-subtle)",
          opacity: 1,
          boxShadow: "none",
        }
      : {};

  function handleDown(e: React.MouseEvent<HTMLElement>) {
    if (disabled || loading) return;
    e.currentTarget.style.transform = "scale(0.975)";
  }
  function handleUp(e: React.MouseEvent<HTMLElement>) {
    e.currentTarget.style.transform = "scale(1)";
  }
  function handleEnter(e: React.MouseEvent<HTMLElement>) {
    if (disabled || loading) return;
    // Longhands only (see variants note) — `style.background` would reset the
    // padding-box clip and re-introduce the edge fringe.
    if (variant === "primary") e.currentTarget.style.boxShadow = "var(--shadow-brand)";
    else if (variant === "solid")
      e.currentTarget.style.backgroundColor = "var(--brand-solid-hover)";
    else if (variant === "secondary") {
      e.currentTarget.style.backgroundColor = "var(--surface-frost-strong)";
      e.currentTarget.style.borderColor = "var(--border-strong)";
    } else if (variant === "ghost") {
      e.currentTarget.style.backgroundColor = "var(--surface-frost)";
      e.currentTarget.style.color = "var(--text-strong)";
    }
  }
  function handleLeave(e: React.MouseEvent<HTMLElement>) {
    const st = e.currentTarget.style;
    st.transform = "scale(1)";
    st.boxShadow = (v.boxShadow as string) || "none";
    // Restore the variant fill via longhands (never the `background` shorthand).
    st.backgroundImage = (v.backgroundImage as string) || "none";
    st.backgroundColor = (v.backgroundColor as string) || "transparent";
    st.borderColor = (v.borderColor as string) || "transparent";
    st.color = v.color as string;
  }

  const classNames = className ? `nine-btn ${className}` : "nine-btn";

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={classNames}
        style={{
          ...base,
          ...v,
          ...style,
          cursor: "pointer",
          opacity: 1,
          textDecoration: "none",
        }}
        onMouseDown={handleDown}
        onMouseUp={handleUp}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {leftIcon}
        {children}
        {rightIcon}
      </a>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      onMouseDown={handleDown}
      onMouseUp={handleUp}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={classNames}
      style={{ ...base, ...v, ...disabledVisual, ...style }}
      {...rest}
    >
      {loading ? <Spinner /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 15,
        height: 15,
        borderRadius: "50%",
        border: "2px solid rgba(255,255,255,0.35)",
        borderTopColor: "#fff",
        display: "inline-block",
        animation: "nineSpin 0.7s linear infinite",
      }}
    >
      <style>{`@keyframes nineSpin{to{transform:rotate(360deg)}}`}</style>
    </span>
  );
}

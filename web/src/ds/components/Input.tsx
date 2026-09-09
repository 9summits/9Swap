import React from "react";

// 9Summits Input — text / number field on dark. Optional leading/trailing
// adornments (icons, token tickers, MAX button). Focus shows the magenta ring.
// Ported from the design system's Input.jsx (prop API kept identical).

export type InputSize = "md" | "lg";

export type InputProps = {
  value?: string | number;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  type?: string;
  size?: InputSize;
  disabled?: boolean;
  invalid?: boolean;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  mono?: boolean;
  id?: string;
  style?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "size" | "prefix" | "style"
>;

export function Input({
  value,
  onChange,
  placeholder = "",
  type = "text",
  size = "md",
  disabled = false,
  invalid = false,
  prefix = null,
  suffix = null,
  mono = false,
  id,
  style = {},
  inputStyle = {},
  ...rest
}: InputProps) {
  const [focus, setFocus] = React.useState(false);
  const sizes: Record<InputSize, { height: number; fontSize: number; padding: number }> = {
    md: { height: 44, fontSize: 14, padding: 14 },
    lg: { height: 54, fontSize: 16, padding: 16 },
  };
  const s = sizes[size] || sizes.md;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: s.height,
        padding: `0 ${s.padding}px`,
        background: "var(--surface-input)",
        border: `1px solid ${
          invalid
            ? "var(--negative)"
            : focus
              ? "var(--border-focus)"
              : "var(--border-default)"
        }`,
        borderRadius: "var(--radius-md)",
        // Focus is shown by the magenta border alone. No ring-brand box-shadow —
        // its 35%-alpha magenta halo reads as a faint extra "transparent frame"
        // around the field on top of the border.
        boxShadow: "none",
        opacity: disabled ? 0.5 : 1,
        transition:
          "border-color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out)",
        ...style,
      }}
    >
      {prefix && (
        <span style={{ display: "inline-flex", color: "var(--text-tertiary)", flex: "none" }}>
          {prefix}
        </span>
      )}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          border: "none",
          outline: "none",
          // Suppress the global :focus-visible ring on the inner <input> too
          // (the wrapper border is the focus indicator).
          boxShadow: "none",
          background: "transparent",
          color: "var(--text-strong)",
          fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
          fontSize: s.fontSize,
          fontWeight: "var(--weight-medium)" as unknown as number,
          fontFeatureSettings: mono ? '"tnum" 1' : "normal",
          ...inputStyle,
        }}
        {...rest}
      />
      {suffix && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            color: "var(--text-secondary)",
            flex: "none",
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

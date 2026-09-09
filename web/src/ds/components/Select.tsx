import React from "react";

// 9Summits Select — custom dropdown on dark. Controlled via `value` + `onChange`.
// Options are `{ value, label }`. Ported from the design system's Select.jsx
// (prop API kept identical).

export type SelectSize = "md" | "sm";

export type SelectOption = { value: string; label: React.ReactNode };

export type SelectProps = {
  value?: string;
  onChange?: (value: string) => void;
  options?: SelectOption[];
  placeholder?: string;
  size?: SelectSize;
  disabled?: boolean;
  id?: string;
  style?: React.CSSProperties;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "style">;

export function Select({
  value,
  onChange,
  options = [],
  placeholder = "Select",
  size = "md",
  disabled = false,
  id,
  style = {},
  ...rest
}: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const sizes: Record<SelectSize, { height: number; fontSize: number }> = {
    md: { height: 44, fontSize: 14 },
    sm: { height: 34, fontSize: 13 },
  };
  const s = sizes[size] || sizes.md;
  const selected = options.find((o) => o.value === value);

  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block", ...style }} {...rest}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          width: "100%",
          height: s.height,
          padding: "0 14px",
          background: "var(--surface-input)",
          border: `1px solid ${open ? "var(--border-focus)" : "var(--border-default)"}`,
          borderRadius: "var(--radius-md)",
          boxShadow: open ? "var(--ring-brand)" : "none",
          color: selected ? "var(--text-strong)" : "var(--text-tertiary)",
          fontFamily: "var(--font-sans)",
          fontSize: s.fontSize,
          fontWeight: "var(--weight-medium)" as unknown as number,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          transition:
            "border-color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out)",
        }}
      >
        {selected ? selected.label : placeholder}
        <Chevron open={open} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            minWidth: "100%",
            background: "var(--surface-elevated)",
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            padding: 6,
            zIndex: 50,
          }}
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange && onChange(o.value);
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "9px 10px",
                  background: active ? "var(--brand-soft)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-sm)",
                  color: active ? "var(--text-link)" : "var(--text-primary)",
                  fontFamily: "var(--font-sans)",
                  fontSize: s.fontSize,
                  fontWeight: (active
                    ? "var(--weight-bold)"
                    : "var(--weight-medium)") as unknown as number,
                  textAlign: "left",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = "var(--surface-frost)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                {o.label}
                {active && <Check />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        color: "var(--text-tertiary)",
        transform: open ? "rotate(180deg)" : "none",
        transition: "transform var(--dur-base) var(--ease-out)",
        flex: "none",
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "var(--brand-pink)", flex: "none" }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

import React from "react";
import { Icon } from "./icons";
import { copyText } from "./copyText";
import { installCliCommand } from "./cliCommand";

// Compact install pill for the header row (same line as brand / chain / wallet).
// x.ai/cli-style `curl | bash`, click-to-copy. Contact stays in the footer.
export function InstallCliBar() {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const installCmd = React.useMemo(() => {
    if (typeof window !== "undefined" && window.location?.origin) {
      const o = window.location.origin;
      // On localhost the binary CDN is still remote — ship the public host so
      // the one-liner actually works when pasted.
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) {
        return installCliCommand("https://swap.9summits.io");
      }
      return installCliCommand(o);
    }
    return installCliCommand();
  }, []);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function onCopy() {
    const ok = await copyText(installCmd);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      data-install-cli-bar
      onClick={onCopy}
      style={s.pill}
      title="Copy install command"
      aria-label={`Copy install command: ${installCmd}`}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-strong)";
        e.currentTarget.style.background = "var(--surface-frost-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-default)";
        e.currentTarget.style.background = "var(--surface-elevated)";
      }}
    >
      <span style={s.prompt} aria-hidden>
        $
      </span>
      <code style={s.cmd}>{installCmd}</code>
      <span style={s.copySlot} aria-hidden>
        {copied ? (
          <Icon name="check" size={14} style={{ color: "var(--positive)" }} />
        ) : (
          <Icon name="copy" size={14} style={{ color: "var(--text-tertiary)" }} />
        )}
      </span>
    </button>
  );
}

const s: Record<string, React.CSSProperties> = {
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
    maxWidth: "100%",
    padding: "7px 11px 7px 12px",
    borderRadius: 999,
    border: "1px solid var(--border-default)",
    background: "var(--surface-elevated)",
    boxShadow: "var(--shadow-inset, inset 0 1px 0 rgba(255,255,255,0.04))",
    cursor: "pointer",
    color: "var(--text-primary)",
    font: "inherit",
    transition:
      "background var(--dur-base, 150ms) ease, border-color var(--dur-base, 150ms) ease",
  },
  prompt: {
    flex: "none",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-tertiary)",
    userSelect: "none",
  },
  cmd: {
    flex: "1 1 auto",
    minWidth: 0,
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-primary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    letterSpacing: "-0.01em",
  },
  copySlot: {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 18,
    height: 18,
  },
};

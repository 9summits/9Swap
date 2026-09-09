import React from "react";
import { copyText } from "./copyText";
import { Icon } from "./icons";

const CONTACT_EMAIL = "contact@9summits.io";
const GITHUB_URL = "https://github.com/9summits/swap-cli";
// Static pages served from web/public — same origin as the deployed dApp.
const DOCS_URL = "/docs.html";
const TERMS_URL = "/terms.html";
// Build-time short SHA from vite.config.ts (`git rev-parse --short` / Vercel).
const APP_COMMIT =
  typeof __APP_COMMIT__ === "string" && __APP_COMMIT__ ? __APP_COMMIT__ : "unknown";
const COMMIT_URL =
  APP_COMMIT !== "unknown"
    ? `${GITHUB_URL}/commit/${APP_COMMIT}`
    : GITHUB_URL;

// Page footer for the interactive dApp: contact (click-to-copy email) + CLI
// docs + terms/disclaimer + the short git commit of this dApp build (links
// to the matching GitHub commit), centered.
export function SiteFooter() {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function copyEmail() {
    const ok = await copyText(CONTACT_EMAIL);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  const label = copied ? "Copied" : "Contact";

  return (
    <footer style={s.footer} data-site-footer>
      <div style={s.inner}>
        <button
          type="button"
          onClick={copyEmail}
          style={s.btn}
          title={`Copy ${CONTACT_EMAIL}`}
          aria-label={`Copy contact email ${CONTACT_EMAIL}`}
        >
          <span>{label}</span>
          <span style={s.muted}>{CONTACT_EMAIL}</span>
        </button>
        <span style={s.dot} aria-hidden>
          ·
        </span>
        <a href={DOCS_URL} style={s.link}>
          <span>Docs</span>
          <span style={s.muted}>CLI manual</span>
        </a>
        <span style={s.dot} aria-hidden>
          ·
        </span>
        <a href={TERMS_URL} style={s.link}>
          <span>Terms</span>
        </a>
        <span style={s.dot} aria-hidden>
          ·
        </span>
        <a
          href={COMMIT_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={s.commit}
          title={`This dApp build · ${APP_COMMIT}`}
          aria-label={`dApp build commit ${APP_COMMIT}`}
        >
          <Icon name="git" size={13} style={s.commitIcon} />
          <code style={s.commitHash}>{APP_COMMIT}</code>
        </a>
      </div>
    </footer>
  );
}

const s: Record<string, React.CSSProperties> = {
  footer: {
    width: "100%",
    marginTop: "auto",
    padding: "20px 40px 28px",
    boxSizing: "border-box",
    borderTop: "1px solid var(--border-subtle)",
    background: "var(--surface-page)",
  },
  inner: {
    maxWidth: 1340,
    margin: "0 auto",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px 14px",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
  },
  btn: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: 8,
    border: "none",
    background: "transparent",
    color: "var(--text-secondary)",
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
  },
  link: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: 8,
    color: "var(--text-secondary)",
    fontWeight: 600,
    textDecoration: "none",
  },
  muted: {
    color: "var(--text-muted, var(--text-tertiary, #8b8794))",
    fontWeight: 500,
    fontSize: 12,
  },
  dot: {
    color: "var(--text-muted, #8b8794)",
    userSelect: "none",
  },
  commit: {
    display: "inline-flex",
    alignItems: "baseline",
    gap: 6,
    color: "var(--text-secondary)",
    fontWeight: 600,
    textDecoration: "none",
  },
  commitIcon: {
    alignSelf: "center",
    color: "var(--text-tertiary)",
  },
  commitHash: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-muted, var(--text-tertiary, #8b8794))",
    letterSpacing: "0.02em",
  },
};

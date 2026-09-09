import React from "react";
import { Icon } from "./icons";

// <ExecStatusView> — the compact execution status used by the interactive dApp
// when SendTx / SignOrder / SignPermitTx run in `compact` + `autoStart` mode.
// The full trade details already live in the SwapForm card, so the execution
// leg here is just a live status line (spinner → ✓ / ✗), an explorer link, and
// a retry on failure. No duplicate "confirm transaction" panel, no extra click:
// the wallet opens the moment the user hits Swap.

export type ExecPhase = "working" | "done" | "error";

// "https://etherscan.io" → "etherscan.io" — the link label carries the
// destination host + the shortened hash so the user knows both where the ↗
// goes and which tx it is before clicking (chain.explorer is a full base URL).
function explorerHost(explorer: string): string {
  try {
    return new URL(explorer).host;
  } catch (e) {
    console.warn("unparseable explorer base URL, using it verbatim:", explorer, e);
    return explorer;
  }
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

function lastPathSegment(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter((p) => p.length > 0);
    const last = segs[segs.length - 1];
    return last ?? url;
  } catch (e) {
    console.warn("unparseable explorer url, using it verbatim:", url, e);
    return url;
  }
}

// One labelled line of the post-execution summary (shown once the tx is mined).
export type SummaryRow = {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "muted";
};

export function ExecStatusView({
  phase,
  text,
  doneText,
  error,
  txHash,
  explorer,
  href,
  onRetry,
  wrongChainName,
  summary,
}: {
  phase: ExecPhase;
  text: string;
  doneText: string;
  error: string | null;
  txHash: string | null;
  explorer: string;
  href?: string | null;
  onRetry?: () => void;
  wrongChainName?: string | null;
  // Execution summary rows — rendered only once mined (phase==="done").
  summary?: SummaryRow[];
}) {
  // null href is "no explorer link" (intent order ids are not tx hashes).
  // Omitted href keeps the chain explorer /tx/ fallback.
  const link = href
    ? href
    : href === null
      ? null
      : txHash
        ? `${explorer}/tx/${txHash}`
        : null;
  const idLabel = txHash
    ? shortHash(txHash)
    : link
      ? shortHash(lastPathSegment(link))
      : "";
  return (
    <div style={s.wrap}>
      {wrongChainName && (
        <div style={s.pending}>
          <Icon name="alert" size={13} style={{ color: "var(--warning)" }} /> switch
          your wallet to {wrongChainName} to continue.
        </div>
      )}
      {phase === "done" ? (
        // Success header: ONE check — a tinted round badge. doneText must not
        // carry its own "✓" (that was the ugly double-check this replaces).
        <div style={s.doneRow}>
          <span style={s.doneBadge}>
            <Icon name="check" size={15} style={{ color: "var(--positive)" }} />
          </span>
          <span style={s.doneText}>{doneText}</span>
        </div>
      ) : (
        <div style={s.row}>
          {phase === "working" && (
            <Icon name="spinner" size={16} style={{ color: "var(--text-secondary)" }} />
          )}
          {phase === "error" && (
            <Icon name="alert" size={16} style={{ color: "var(--negative)" }} />
          )}
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: phase === "error" ? "var(--negative)" : "var(--text-secondary)",
            }}
          >
            {phase === "error" ? "Transaction failed" : text}
          </span>
        </div>
      )}
      {phase === "done" && summary && summary.length > 0 && (
        <div style={s.summary}>
          {summary.map((r) => (
            <div key={r.label} style={s.sumRow}>
              <span style={s.sumLabel}>{r.label}</span>
              <span
                style={{
                  ...s.sumValue,
                  color:
                    r.tone === "pos"
                      ? "var(--positive)"
                      : r.tone === "neg"
                        ? "var(--text-strong)"
                        : r.tone === "muted"
                          ? "var(--text-tertiary)"
                          : "var(--text-secondary)",
                }}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      )}
      {link && (
        <a href={link} target="_blank" rel="noreferrer" style={s.link}>
          {explorerHost(link)} · {idLabel} ↗
        </a>
      )}
      {phase === "error" && error && (
        <div style={s.errBox}>
          <span style={{ wordBreak: "break-word" }}>{error}</span>
          {onRetry && (
            <button type="button" onClick={onRetry} style={s.retry}>
              retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 10 },
  row: { display: "flex", alignItems: "center", gap: 9 },
  doneRow: { display: "flex", alignItems: "center", gap: 10 },
  doneBadge: {
    width: 30,
    height: 30,
    borderRadius: "50%",
    background: "var(--positive-bg)",
    border: "1px solid rgba(47, 227, 154, 0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  },
  doneText: { fontSize: 14, fontWeight: 700, color: "var(--positive)" },
  pending: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12,
    color: "var(--warning)",
  },
  summary: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "10px 12px",
    background: "var(--surface-frost)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
  },
  sumRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sumLabel: {
    fontSize: 12,
    color: "var(--text-tertiary)",
  },
  sumValue: {
    fontFamily: "var(--font-mono)",
    fontSize: 12.5,
    fontWeight: 700,
    textAlign: "right",
    wordBreak: "break-all",
  },
  link: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-link)",
    textDecoration: "none",
  },
  errBox: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
  },
  retry: {
    flex: "none",
    border: "1px solid var(--border-default)",
    background: "var(--surface-frost)",
    color: "var(--text-secondary)",
    borderRadius: "var(--radius-pill)",
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
  },
};

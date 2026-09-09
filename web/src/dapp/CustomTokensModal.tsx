import React from "react";
import { useAccount } from "wagmi";
import type { EIP1193Provider } from "viem";
import { Button } from "../ds/components/Button";
import { Input } from "../ds/components/Input";
import { Select } from "../ds/components/Select";
import { Icon } from "./icons";
import { TokenIcon } from "./TokenIcon";
import { copyText } from "./copyText";
import { knownChains } from "../wagmi";
import { resolveToken, sessionId } from "./api";
import {
  addCustomToken,
  chainMetaForAlias,
  chainMetaForId,
  CUSTOM_TOKEN_CHAINS,
  fetchErc20Meta,
  listAllCustomTokens,
  listedTokensToCsv,
  parseCustomTokensCsv,
  removeCustomToken,
  type CsvParseError,
  type ListedCustomToken,
} from "./customTokens";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const CHAIN_OPTIONS = CUSTOM_TOKEN_CHAINS.map((c) => ({
  value: c.alias,
  label: `${c.name} (${c.alias})`,
}));

export type CustomTokensModalProps = {
  open: boolean;
  onClose: () => void;
  defaultChainId: number;
};

export function CustomTokensModal({
  open,
  onClose,
  defaultChainId,
}: CustomTokensModalProps) {
  const { chainId: walletChainId, connector } = useAccount();
  const walletRef = React.useRef({ chainId: walletChainId, connector });
  walletRef.current = { chainId: walletChainId, connector };

  const [tokens, setTokens] = React.useState<ListedCustomToken[]>([]);
  const [addChain, setAddChain] = React.useState("eth");
  const [addAddress, setAddAddress] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);

  const [csvText, setCsvText] = React.useState("");
  const [importErrors, setImportErrors] = React.useState<CsvParseError[]>([]);
  const [importNote, setImportNote] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = React.useCallback(() => {
    setTokens(listAllCustomTokens());
  }, []);

  React.useEffect(() => {
    if (!open) return;
    reload();
    setAddError(null);
    setAdding(false);
    setAddAddress("");
    setCsvText("");
    setImportErrors([]);
    setImportNote(null);
    setCopied(false);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    const meta = chainMetaForId(defaultChainId);
    setAddChain(meta?.alias ?? "eth");
  }, [open, defaultChainId, reload]);

  React.useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function onAdd() {
    const q = addAddress.trim();
    const meta = chainMetaForAlias(addChain);
    if (!meta) {
      setAddError(`unknown chain "${addChain}"`);
      return;
    }
    const looksLikeAddress = q.startsWith("0x");
    if (looksLikeAddress && !ADDRESS_RE.test(q)) {
      setAddError("Address must be 0x + 40 hex chars.");
      return;
    }
    if (!looksLikeAddress && q.length < 2) {
      setAddError("Enter a token symbol (2+ chars) or a 0x address.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      let token;
      if (ADDRESS_RE.test(q)) {
        const wallet = walletRef.current;
        let walletProvider: EIP1193Provider | undefined;
        if (wallet.chainId === meta.chainId && wallet.connector?.getProvider) {
          walletProvider = (await wallet.connector
            .getProvider()
            .catch(() => undefined)) as EIP1193Provider | undefined;
        }
        token = await fetchErc20Meta(meta.chainId, q, walletProvider);
      } else {
        token = await resolveToken(sessionId(), meta.alias, q);
      }
      addCustomToken(meta.chainId, token);
      setAddAddress("");
      reload();
    } catch (err) {
      console.error("CustomTokensModal: add failed", err);
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  function onRemove(chainId: number, address: string) {
    removeCustomToken(chainId, address);
    reload();
  }

  const csv = listedTokensToCsv(tokens);

  async function onCopyCsv() {
    const ok = await copyText(csv);
    if (ok) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }
  }

  function onDownloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "swap-custom-tokens.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function onImport() {
    setImportNote(null);
    const { ok, errors } = parseCustomTokensCsv(csvText);
    setImportErrors(errors);
    if (ok.length === 0) {
      setImportNote(
        errors.length === 0 ? "No rows to import." : "No valid rows to import.",
      );
      return;
    }
    for (const row of ok) {
      addCustomToken(row.chainId, {
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
      });
    }
    reload();
    setImportNote(
      errors.length === 0
        ? `Imported ${ok.length} token${ok.length === 1 ? "" : "s"}.`
        : `Imported ${ok.length}; skipped ${errors.length} bad row${errors.length === 1 ? "" : "s"}.`,
    );
  }

  return (
    <div style={d.overlay} onClick={onClose}>
      <div
        style={d.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage custom tokens"
      >
        <div style={d.head}>
          <span style={d.title}>Manage custom tokens</span>
          <button
            type="button"
            style={d.closeBtn}
            onClick={onClose}
            aria-label="Close"
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-strong)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-tertiary)")}
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div style={d.addRow}>
          <Select
            size="md"
            value={addChain}
            onChange={setAddChain}
            options={CHAIN_OPTIONS}
            aria-label="Chain"
            style={{ width: 200, flex: "none" }}
          />
          <Input
            value={addAddress}
            onChange={(e) => setAddAddress(e.target.value)}
            placeholder="Symbol or 0x address"
            mono={addAddress.trim().startsWith("0x")}
            invalid={
              addAddress.trim().startsWith("0x") &&
              !ADDRESS_RE.test(addAddress.trim())
            }
            aria-label="Token symbol or address"
            style={{ flex: 1, minWidth: 0 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onAdd();
              }
            }}
          />
          <Button
            variant="secondary"
            size="md"
            onClick={() => void onAdd()}
            loading={adding}
            disabled={adding}
            leftIcon={<Icon name="plus" size={14} />}
          >
            Add
          </Button>
        </div>
        {addError && (
          <div style={d.errorLine}>
            <Icon name="alert" size={14} />
            <span>{addError}</span>
          </div>
        )}

        <div style={d.tableWrap}>
          <div style={d.tableHead}>
            <span>Chain</span>
            <span>Name</span>
            <span>Address</span>
            <span>Icon</span>
            <span />
          </div>
          {tokens.length === 0 && (
            <div style={d.empty}>
              No custom tokens yet. Add a symbol or address, or import a CSV.
            </div>
          )}
          {tokens.map((row) => {
            const addr = row.token.address;
            const explorer = knownChains.find((c) => c.id === row.chainId)
              ?.blockExplorers?.default.url;
            return (
              <div
                key={`${row.chainId}:${addr.toLowerCase()}`}
                style={d.tableRow}
              >
                <span style={d.chainCell} title={row.chainName}>
                  {row.alias}
                </span>
                <span style={d.nameCell}>
                  <span style={d.sym}>{row.token.symbol}</span>
                  <span style={d.name}>{row.token.name}</span>
                </span>
                {explorer ? (
                  <a
                    href={`${explorer}/token/${addr}`}
                    target="_blank"
                    rel="noreferrer"
                    style={d.addr}
                    title={`Open on ${new URL(explorer).host}`}
                  >
                    {addr} ↗
                  </a>
                ) : (
                  <span style={d.addr}>{addr}</span>
                )}
                <span style={d.iconCell}>
                  <TokenIcon
                    token={row.token}
                    chainId={row.chainId}
                    size="sm"
                    bare
                    lazy
                  />
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${row.token.symbol} on ${row.alias}`}
                  title={`Remove ${row.token.symbol}`}
                  style={d.removeBtn}
                  onClick={() => onRemove(row.chainId, addr)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--negative)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-tertiary)";
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <div style={d.exportRow}>
          <span style={d.sectionLabel}>Export all</span>
          <div style={d.exportBtns}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onCopyCsv()}
              leftIcon={<Icon name="copy" size={14} />}
            >
              {copied ? "Copied" : "Copy CSV"}
            </Button>
            <Button variant="secondary" size="sm" onClick={onDownloadCsv}>
              Download
            </Button>
          </div>
        </div>

        <span style={d.sectionLabel}>Import CSV</span>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={"chain,symbol,name,address,decimals\neth,USDC,USD Coin,0x…,6"}
          spellCheck={false}
          aria-label="CSV to import"
          style={d.textarea}
        />
        <div style={d.importRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={onImport}
            disabled={!csvText.trim()}
          >
            Import
          </Button>
          {importNote && <span style={d.importNote}>{importNote}</span>}
        </div>
        {importErrors.length > 0 && (
          <ul style={d.errorList}>
            {importErrors.map((err) => (
              <li key={`${err.line}:${err.message}`}>
                line {err.line}: {err.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const d: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 60,
    background: "var(--surface-overlay)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modal: {
    width: 680,
    maxWidth: "92vw",
    maxHeight: "82vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-xl)",
    padding: 22,
    boxSizing: "border-box",
    fontFamily: "var(--font-sans)",
    gap: 12,
    overflowY: "auto",
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  title: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 18,
    color: "var(--text-strong)",
  },
  closeBtn: {
    display: "inline-flex",
    padding: 6,
    background: "transparent",
    border: "none",
    color: "var(--text-tertiary)",
    cursor: "pointer",
    transition: "color var(--dur-base) var(--ease-out)",
  },
  addRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  errorLine: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 12,
    lineHeight: 1.4,
    color: "var(--negative)",
  },
  tableWrap: {
    display: "flex",
    flexDirection: "column",
    minHeight: 120,
    maxHeight: 280,
    overflowY: "auto",
    margin: "0 -6px",
    padding: "0 6px",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
  },
  tableHead: {
    display: "grid",
    gridTemplateColumns: "64px 1fr auto 36px 32px",
    gap: 8,
    padding: "8px 10px",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
    borderBottom: "1px solid var(--border-subtle)",
    position: "sticky",
    top: 0,
    background: "var(--surface-elevated)",
    zIndex: 1,
  },
  tableRow: {
    display: "grid",
    gridTemplateColumns: "64px 1fr auto 36px 32px",
    gap: 8,
    alignItems: "center",
    padding: "8px 10px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  chainCell: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-secondary)",
  },
  nameCell: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    minWidth: 0,
  },
  sym: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  name: {
    fontSize: 11,
    color: "var(--text-tertiary)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  addr: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
    whiteSpace: "nowrap",
    textDecoration: "none",
  },
  iconCell: {
    display: "inline-flex",
    justifyContent: "center",
  },
  removeBtn: {
    display: "inline-flex",
    padding: 4,
    background: "transparent",
    border: "none",
    color: "var(--text-tertiary)",
    cursor: "pointer",
    transition: "color var(--dur-base) var(--ease-out)",
  },
  empty: {
    padding: "24px 12px",
    textAlign: "center",
    fontSize: 13,
    color: "var(--text-tertiary)",
  },
  exportRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  exportBtns: {
    display: "inline-flex",
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--text-tertiary)",
  },
  textarea: {
    width: "100%",
    minHeight: 96,
    resize: "vertical",
    boxSizing: "border-box",
    padding: 12,
    background: "var(--surface-input)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-strong)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.45,
    outline: "none",
  },
  importRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  importNote: {
    fontSize: 12,
    color: "var(--text-secondary)",
  },
  errorList: {
    margin: 0,
    padding: "0 0 0 18px",
    fontSize: 12,
    lineHeight: 1.45,
    color: "var(--negative)",
    maxHeight: 88,
    overflowY: "auto",
  },
};

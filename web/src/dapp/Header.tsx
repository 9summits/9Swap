import React, { useEffect, useRef, useState } from "react";
import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useDisconnect } from "wagmi";
import { Button } from "../ds/components/Button";
import { Badge } from "../ds/components/Badge";
import { Icon } from "./icons";
import { short, clogo, ctint } from "./venues";
import type { HeaderProps, ChainMeta } from "./types";
import { InstallCliBar } from "./InstallCliBar";

// dApp Header — ported from the swap prototype's <Header> + <ChainChip>
// (/tmp/9s-design/ui_kits/swap/app.jsx). Left: the favicon mark +
// "swap-cli" wordmark. Center: install CLI pill (same row, never stacked above).
// Right: chain selector + wallet connect (RainbowKit).
//
// Self-contained: imports only RainbowKit + DS primitives + local helpers. The
// connected wallet is the dApp sender (no --from in interactive mode).

/* ------------------------------- brand mark ------------------------------- */
// Same glyph as web/public/favicon.svg so the in-page mark matches the tab
// icon. Inlined rather than imported: the typecheck has no ambient *.svg
// module declaration. The tile is filled with a raised surface + hairline
// because the favicon's own #0d1117 tile would vanish into the header overlay.
function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="geometricPrecision"
      style={{ flex: "none", display: "block" }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="hdr_warm" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FE9655" />
          <stop offset="1" stopColor="#E90091" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="62"
        height="62"
        rx="13"
        strokeWidth="2"
        style={{ fill: "var(--surface-raised)", stroke: "var(--border-subtle)" }}
      />
      <path
        d="M12 15 L29 32 L12 49"
        fill="none"
        stroke="#3fb950"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="36" y="40" width="17" height="11" rx="2" fill="url(#hdr_warm)" />
    </svg>
  );
}

/* -------------------------------- chain mark ------------------------------ */
// The round chain glyph: the real chain logo (DeFiLlama chain CDN) over the
// brand tint, falling back to a tinted dot if the logo URL is unknown or fails
// to load. Mirrors the venue VenueMark pattern in RoutesPane.
function ChainMark({ chain, size = 18 }: { chain: ChainMeta; size?: number }) {
  const logo = clogo(chain.chainId);
  const tint = ctint(chain.chainId);
  const [failed, setFailed] = useState(false);
  if (logo && !failed) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          flex: "none",
          display: "block",
          objectFit: "cover",
        }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "none",
        background: tint,
        boxShadow: `0 0 6px ${tint}`,
      }}
    />
  );
}

/* ------------------------------ chain selector ---------------------------- */
// Dropdown over the `chains` prop, styled as the prototype's ChainChip. Clicking
// opens a small popover of the available chains; selecting one calls onChain.
function ChainSelector({ chains, chain, onChain }: HeaderProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Single chain → render a static (non-interactive) chip, matching the
  // prototype's look with no dropdown affordance.
  const interactive = chains.length > 1;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        style={{ ...s.chip, cursor: interactive ? "pointer" : "default" }}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        aria-haspopup={interactive ? "listbox" : undefined}
        aria-expanded={interactive ? open : undefined}
      >
        <ChainMark chain={chain} />
        <span style={s.chainName} data-chain-name>{chain.name}</span>
        {interactive && (
          <Icon
            name="chevron"
            size={14}
            style={{
              color: "var(--text-tertiary)",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform var(--dur-fast) var(--ease-out)",
            }}
          />
        )}
      </button>

      {open && interactive && (
        <div role="listbox" style={s.menu}>
          {chains.map((c) => {
            const selected = c.alias === chain.alias;
            return (
              <button
                key={c.alias}
                type="button"
                role="option"
                aria-selected={selected}
                style={{
                  ...s.menuItem,
                  background: selected ? "var(--surface-frost)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!selected) e.currentTarget.style.background = "var(--surface-frost)";
                }}
                onMouseLeave={(e) => {
                  if (!selected) e.currentTarget.style.background = "transparent";
                }}
                onClick={() => {
                  onChain(c);
                  setOpen(false);
                }}
              >
                <ChainMark chain={c} />
                <span style={s.menuName}>{c.name}</span>
                <span style={s.menuMeta}>{c.nativeSymbol}</span>
                {selected && (
                  <Icon
                    name="check"
                    size={14}
                    style={{ color: "var(--positive)", marginLeft: "auto" }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ wallet mark ------------------------------- */
// Logo of the connected provider (Fordefi, Rabby, MetaMask, WalletConnect, …)
// so the chip shows *which* wallet is live — not just the address.
//
// Sources, in order:
//   1. wagmi `connector.icon` — EIP-6963 wallets (installed extensions announce
//      their own icon as a data URI; this is how Fordefi/Rabby/MM show up).
//   2. RainbowKit `connector.rkDetails.iconUrl` — wallets registered via
//      connectorsForWallets (string or async loader returning a data URI).
// Falls back to the green status dot when neither yields a usable image.
function useWalletIcon(): { iconUrl: string | null; name: string | null } {
  const { connector } = useAccount();
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIconUrl(null);
    if (!connector) return;

    if (typeof connector.icon === "string" && connector.icon) {
      setIconUrl(connector.icon);
      return;
    }

    // rkDetails is only present on RainbowKit-created connectors (not EIP-6963).
    const rk = (
      connector as {
        rkDetails?: { iconUrl?: string | (() => Promise<string>) };
      }
    ).rkDetails;
    const raw = rk?.iconUrl;
    if (!raw) return;
    if (typeof raw === "function") {
      void raw().then((url) => {
        if (!cancelled && url) setIconUrl(url);
      });
      return () => {
        cancelled = true;
      };
    }
    setIconUrl(raw);
  }, [connector]);

  return { iconUrl, name: connector?.name ?? null };
}

function WalletMark({ size = 18 }: { size?: number }) {
  const { iconUrl, name } = useWalletIcon();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [iconUrl]);

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        title={name ?? undefined}
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          flex: "none",
          display: "block",
          objectFit: "cover",
          background: "var(--surface-elevated)",
        }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <span style={s.walletDot} title={name ?? undefined} />;
}

/* ------------------------------ wallet control ---------------------------- */
// RainbowKit ConnectButton.Custom — brand-styled trigger. Disconnected → the
// prototype's primary "Connect Wallet" button (opens RainbowKit's modal).
// Connected → walletChip with provider logo + short address; click opens a
// local menu (copy address / switch wallet / disconnect). Wrong-network → a
// danger chip that opens RainbowKit's chain modal.
function WalletControl() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const pendingSwitch = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { disconnect } = useDisconnect();
  const { isConnected } = useAccount();
  const { openConnectModal: openConnectAfterSwitch } = useConnectModal();

  useEffect(() => {
    if (!pendingSwitch.current || isConnected || !openConnectAfterSwitch) return;
    pendingSwitch.current = false;
    openConnectAfterSwitch();
  }, [isConnected, openConnectAfterSwitch]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, openChainModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        // Until wagmi/RainbowKit hydrates, render a non-interactive placeholder
        // (RainbowKit's documented pattern) so the trigger doesn't flash.
        if (!ready) {
          return (
            <div
              aria-hidden
              style={{ opacity: 0, pointerEvents: "none", userSelect: "none" }}
            >
              <Button variant="primary" size="sm" leftIcon={<Icon name="wallet" size={15} />}>
                Connect Wallet
              </Button>
            </div>
          );
        }

        if (!connected) {
          return (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Icon name="wallet" size={15} />}
              onClick={openConnectModal}
            >
              Connect Wallet
            </Button>
          );
        }

        if (chain.unsupported) {
          return (
            <button type="button" style={s.walletChipWarn} onClick={openChainModal}>
              <Icon name="alert" size={14} style={{ color: "var(--negative)" }} />
              <span style={s.walletWarnText}>Wrong network</span>
            </button>
          );
        }

        return (
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              type="button"
              style={s.walletChip}
              onClick={() => setOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`Connected wallet ${short(account.address)}`}
            >
              <WalletMark />
              <span style={s.walletAddr}>{short(account.address)}</span>
              <Icon
                name="chevron"
                size={14}
                style={{
                  color: "var(--text-tertiary)",
                  transform: open ? "rotate(180deg)" : "none",
                  transition: "transform var(--dur-fast) var(--ease-out)",
                }}
              />
            </button>
            {open && (
              <div role="menu" style={s.menu}>
                <button
                  type="button"
                  role="menuitem"
                  style={{ ...s.menuItem, background: "transparent" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--surface-frost)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    void navigator.clipboard.writeText(account.address);
                    setCopied(true);
                    if (copiedTimer.current) clearTimeout(copiedTimer.current);
                    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Icon name="copy" size={14} style={{ color: "var(--text-tertiary)" }} />
                  <span style={s.menuName}>{copied ? "Copied" : "Copy address"}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={{ ...s.menuItem, background: "transparent" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--surface-frost)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    setOpen(false);
                    pendingSwitch.current = true;
                    disconnect();
                  }}
                >
                  <Icon name="wallet" size={14} style={{ color: "var(--text-tertiary)" }} />
                  <span style={s.menuName}>Switch wallet</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  style={{ ...s.menuItem, background: "transparent" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--surface-frost)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                  onClick={() => {
                    setOpen(false);
                    disconnect();
                  }}
                >
                  <Icon name="x" size={14} style={{ color: "var(--negative)" }} />
                  <span style={{ ...s.menuName, color: "var(--negative)" }}>Disconnect</span>
                </button>
              </div>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

/* --------------------------------- header --------------------------------- */
// Three columns on one row: brand | install pill (true center) | chain+wallet.
// Grid 1fr auto 1fr keeps brand/wallet on the sides without pushing height.
export function Header({ chains, chain, onChain }: HeaderProps) {
  return (
    <header style={s.header}>
      <div style={s.headerInner} data-dapp-header-inner>
        <div style={s.sideLeft}>
          <BrandMark size={30} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={s.brandWord}>swap-cli</span>
              <Badge tone="brand" variant="soft" size="sm" aria-label="Beta">
                Beta
              </Badge>
            </div>
            <span style={s.brandSub} data-brand-sub>
              Swap CLI & Dapp Aggregator by 9Summits
            </span>
          </div>
        </div>
        <div style={s.center} data-header-install>
          <InstallCliBar />
        </div>
        <div style={s.sideRight}>
          <ChainSelector chains={chains} chain={chain} onChain={onChain} />
          <WalletControl />
        </div>
      </div>
    </header>
  );
}

/* --------------------------------- styles --------------------------------- */
const s: Record<string, React.CSSProperties> = {
  header: {
    position: "sticky",
    top: 0,
    zIndex: 20,
    background: "var(--surface-overlay)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    borderBottom: "1px solid var(--border-subtle)",
  },
  headerInner: {
    maxWidth: 1320,
    margin: "0 auto",
    padding: "0 40px",
    height: 66,
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    columnGap: 16,
    minWidth: 0,
  },
  sideLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
    justifySelf: "start",
  },
  center: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
    maxWidth: "min(52vw, 520px)",
  },
  sideRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    justifySelf: "end",
    minWidth: 0,
  },
  brandWord: {
    fontFamily: "var(--font-mono)",
    fontSize: 15,
    fontWeight: 700,
    color: "var(--text-strong)",
    letterSpacing: "0.06em",
    lineHeight: 1,
  },
  brandSub: {
    fontSize: 10,
    fontWeight: 600,
    color: "var(--text-tertiary)",
    letterSpacing: "0.03em",
    lineHeight: 1,
    whiteSpace: "nowrap",
  },

  // ChainChip (prototype d.chip), promoted to a real button.
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    background: "var(--surface-frost)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-pill)",
    whiteSpace: "nowrap",
  },
  chainName: { fontWeight: 700, fontSize: 13, color: "var(--text-strong)" },

  // Chain dropdown menu.
  menu: {
    position: "absolute",
    top: "calc(100% + 8px)",
    right: 0,
    minWidth: 200,
    zIndex: 30,
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-lg)",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "9px 10px",
    border: "none",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  },
  menuName: { fontWeight: 700, fontSize: 13, color: "var(--text-strong)" },
  menuMeta: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-tertiary)",
  },

  // walletChip (prototype d.walletChip).
  walletChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 9,
    padding: "8px 14px",
    background: "var(--surface-frost)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-pill)",
    cursor: "pointer",
    flex: "none",
    whiteSpace: "nowrap",
  },
  walletDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flex: "none",
    background: "var(--positive)",
    boxShadow: "0 0 8px var(--positive)",
  },
  walletAddr: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    color: "var(--text-strong)",
  },

  walletChipWarn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 14px",
    background: "var(--negative-bg)",
    border: "1px solid rgba(255,92,108,0.4)",
    borderRadius: "var(--radius-pill)",
    cursor: "pointer",
    flex: "none",
    whiteSpace: "nowrap",
  },
  walletWarnText: { fontSize: 13, fontWeight: 700, color: "var(--negative)" },
};

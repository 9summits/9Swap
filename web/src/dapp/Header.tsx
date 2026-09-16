import React, { useEffect, useRef, useState } from "react";
import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useDisconnect } from "wagmi";
import { Button } from "../ds/components/Button";
import { Badge } from "../ds/components/Badge";
import { Icon } from "./icons";
import { short, clogo, ctint } from "./venues";
import type { HeaderProps, ChainMeta } from "./types";
import { InstallCliBar } from "./InstallCliBar";
import { PrivacyPill } from "./PrivacyPill";

// dApp Header — ported from the swap prototype's <Header> + <ChainChip>
// (/tmp/9s-design/ui_kits/swap/app.jsx). Left: the 9Summits "9" mark +
// "9Swap" wordmark, then the Beta badge and, next to it, the "No tracking"
// pill (<PrivacyPill>, own file) linking to the disclaimer's Privacy section
// (hidden on phones).
// Center: install CLI pill (same row, never stacked above).
// Right: chain selector + wallet connect (RainbowKit).
//
// Self-contained: imports only RainbowKit + DS primitives + local helpers. The
// connected wallet is the dApp sender (no --from in interactive mode).

/* ------------------------------- brand mark ------------------------------- */
// 9Summits symbol (web/src/ds/symbol_9summits.svg), inlined so the CLI
// single-file embed does not depend on an extra asset. `size` is the height;
// width follows the mark's 145×172 viewBox.
function BrandMark({ size = 30 }: { size?: number }) {
  const width = Math.round((size * 145) / 172);
  return (
    <svg
      width={width}
      height={size}
      viewBox="0 0 145 172"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flex: "none", display: "block" }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="brand9_body" x1="124.5" y1="85.9382" x2="22.5" y2="85.9382" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E90091" />
          <stop offset="0.346154" stopColor="#FE2F8A" />
          <stop offset="0.5" stopColor="#FE4D7A" />
          <stop offset="0.65" stopColor="#FE6E6A" />
          <stop offset="1" stopColor="#FE9655" />
        </linearGradient>
        <linearGradient id="brand9_left" x1="40.2994" y1="75.029" x2="56.7994" y2="132.529" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF008C" />
          <stop offset="1" stopColor="#590046" />
        </linearGradient>
        <radialGradient
          id="brand9_right"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(81.2994 51.0289) rotate(90) scale(102.5 81.4445)"
        >
          <stop stopColor="#FF9B54" />
          <stop offset="0.61407" stopColor="#FF008C" />
          <stop offset="1" stopColor="#681775" />
        </radialGradient>
      </defs>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M72.4936 0C112.516 0 145 32.4852 145 72.4976C145 89.185 139.35 104.563 129.859 116.822L129.861 116.824C128.531 118.541 127.126 120.198 125.65 121.788L81.9056 171.875H81.9007L81.8997 171.876H33.5687L58.2222 143.588C25.0367 136.951 0 107.625 0 72.4976C0 32.4852 32.4838 0 72.4936 0ZM101.414 94.3581L90.8001 63.0004L72.0384 50.7699L54.2474 62.3285L40.1488 88.8652C37.6534 83.9473 36.2466 78.3854 36.2466 72.4976C36.2466 52.4914 52.4887 36.2481 72.4936 36.2481C92.5113 36.2481 108.753 52.4914 108.753 72.4976C108.753 80.7049 106.02 88.279 101.414 94.3581Z"
        fill="url(#brand9_body)"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M58.2229 143.587C57.5595 143.454 56.8995 143.312 56.243 143.162C37.6943 138.904 21.8518 127.522 11.7542 112.056L29.0355 98.8175L35.4162 97.7726L54.2469 62.3284L71.7221 50.8238L64.1474 62.9013L68.279 72.8385L59.2229 89.9917L68.279 107.748L56.0182 101.75L49.492 112.1L69.1223 119.155L76.5265 115.211L77.4362 121.543L58.2229 143.587ZM71.9203 50.6932L71.9993 50.6416L72.0383 50.7699L71.9203 50.6932Z"
        fill="url(#brand9_left)"
      />
      <path
        d="M71.7235 50.8234L71.9228 50.6929L90.7966 62.9009L101.799 95.5289L110.98 105.768L121.842 106.467L129.86 116.824C128.512 118.568 127.08 120.25 125.582 121.864L81.9021 171.876H33.5701L77.4375 121.542L76.5252 115.211L69.1196 119.155L49.4908 112.1L56.0217 101.749L68.2799 107.748L59.2237 89.9922L68.2799 72.8386L64.1474 62.9009L71.7235 50.8234Z"
        fill="url(#brand9_right)"
      />
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
function ChainSelector({ chains, chain, onChain, locked }: HeaderProps) {
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
  const interactive = chains.length > 1 && !locked;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        style={{ ...s.chip, cursor: interactive ? "pointer" : "default" }}
        onClick={interactive ? () => setOpen((v) => !v) : undefined}
        aria-haspopup={interactive ? "listbox" : undefined}
        aria-expanded={interactive ? open : undefined}
        title={locked ? "Chain is set by the Safe" : undefined}
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
export function Header({ chains, chain, onChain, locked }: HeaderProps) {
  return (
    <header style={s.header}>
      <div style={s.headerInner} data-dapp-header-inner>
        <div style={s.sideLeft}>
          <BrandMark size={30} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={s.brandWord}>9Swap</span>
              <Badge tone="brand" variant="soft" size="sm" aria-label="Beta">
                Beta
              </Badge>
              <PrivacyPill />
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
          <ChainSelector
            chains={chains}
            chain={chain}
            onChain={onChain}
            locked={locked}
          />
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

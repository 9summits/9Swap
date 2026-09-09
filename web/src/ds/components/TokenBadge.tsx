import React from "react";

// 9Summits TokenBadge — an asset chip: a coin glyph plus its ticker. Pass
// `logo` for the real token SVG; without one it renders a tinted coin with the
// ticker initials. Ported from the design system's TokenBadge.jsx (prop API
// kept identical).

const COIN_TINTS: Record<string, string> = {
  USDC: "#2775ca",
  USDT: "#26a17b",
  DAI: "#f5ac37",
  ETH: "#627eea",
  WETH: "#627eea",
  WBTC: "#f09242",
  BTC: "#f7931a",
  default: "var(--brand-purple)",
};

export type TokenBadgeSize = "sm" | "md" | "lg";

export type TokenBadgeProps = {
  ticker?: string;
  logo?: string | null;
  size?: TokenBadgeSize;
  network?: string | null;
  bare?: boolean;
  style?: React.CSSProperties;
  // Fires when the `logo` image fails to load — lets a caller walk a fallback
  // chain of icon URLs (see dapp/TokenIcon.tsx) before the initials show.
  onLogoError?: React.ReactEventHandler<HTMLImageElement>;
  onLogoLoad?: React.ReactEventHandler<HTMLImageElement>;
  loading?: "eager" | "lazy";
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "style">;

export function TokenBadge({
  ticker = "",
  logo = null,
  size = "md",
  network = null,
  bare = false,
  style = {},
  onLogoError,
  onLogoLoad,
  loading,
  ...rest
}: TokenBadgeProps) {
  const sizes: Record<TokenBadgeSize, { coin: number; font: number }> = {
    sm: { coin: 18, font: 12 },
    md: { coin: 24, font: 14 },
    lg: { coin: 32, font: 16 },
  };
  const s = sizes[size] || sizes.md;
  const tint = COIN_TINTS[ticker.toUpperCase()] || COIN_TINTS.default;

  const coin = (
    <span style={{ position: "relative", flex: "none", width: s.coin, height: s.coin }}>
      <span
        style={{
          width: s.coin,
          height: s.coin,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          background: logo ? "var(--ink-800)" : tint,
          color: "#fff",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: s.coin * 0.42,
          boxShadow: "var(--shadow-inset)",
        }}
      >
        {logo ? (
          <img
            src={logo}
            alt={ticker}
            loading={loading}
            decoding="async"
            onError={onLogoError}
            onLoad={onLogoLoad}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          ticker.slice(0, 1).toUpperCase()
        )}
      </span>
      {network && (
        <span
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: s.coin * 0.5,
            height: s.coin * 0.5,
            borderRadius: "50%",
            background: network,
            border: "2px solid var(--surface-card)",
          }}
        />
      )}
    </span>
  );

  if (bare)
    return (
      <span style={{ display: "inline-flex", ...style }} {...rest}>
        {coin}
      </span>
    );

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }} {...rest}>
      {coin}
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: s.font,
          fontWeight: "var(--weight-bold)" as unknown as number,
          color: "var(--text-strong)",
          letterSpacing: "0.01em",
        }}
      >
        {ticker}
      </span>
    </span>
  );
}

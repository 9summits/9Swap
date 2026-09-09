import React from "react";
import { getAddress } from "viem";
import { TokenBadge, type TokenBadgeSize } from "../ds/components/TokenBadge";
import type { TokenInfo } from "./types";
import { NATIVE_SENTINEL } from "./useQuote";
import {
  forgetIcon,
  hydrateIconCache,
  iconKey,
  peekIcon,
  persistIconFromUrl,
  rememberIcon,
} from "./iconCache";

// Token icon with a CDN fallback chain + a persistent blob cache.
//
// Tokens from the curated list (GET /api/tokens) carry a `logoURI` rewritten
// to `/api/icon`; tokens resolved on the fly (POST /api/resolve-token, or the
// client-side on-chain ERC20 fallback) don't, and used to drop straight to
// TokenBadge's letter placeholder. This wrapper walks a list of candidate
// URLs — the token's own logoURI first, then 1inch's flat token CDN, then
// TrustWallet's per-chain asset repo — advancing on each <img> load error,
// and reaches the placeholder only once every candidate has missed.
//
// A 403/404 from an icon CDN is the nominal miss signal here, not a failure,
// so nothing is logged. Winning blobs are stored in Cache Storage (see
// iconCache.ts) so picker remounts and full reloads don't flash empty coins.

// TrustWallet's blockchain folder names, for the chains it actually covers.
// Chains absent from this map (unichain, hyperEvm, …) skip that candidate.
const TRUSTWALLET_SLUGS: Record<number, string> = {
  1: "ethereum",
  56: "smartchain",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  43114: "avalanchec",
};

// Candidate URLs in try order. Addresses are validated upstream (token
// resolution), so getAddress() is safe to call without a guard here.
function candidatesFor(token: TokenInfo, chainId: number): string[] {
  const address = token.address.toLowerCase();
  const out: string[] = [];
  if (token.logoURI) out.push(token.logoURI);
  // Native has no contract for any CDN to key off — logoURI or placeholder.
  if (address === NATIVE_SENTINEL) return out;
  // Flat form only: the /v1.2/<chainId>/ variant 404s even for tokens the flat
  // path serves, and the flat path covers non-mainnet chains fine.
  out.push(`https://tokens.1inch.io/${address}.png`);
  const slug = TRUSTWALLET_SLUGS[chainId];
  if (slug !== undefined) {
    out.push(
      `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${slug}/assets/${getAddress(address)}/logo.png`,
    );
  }
  return out;
}

export type TokenIconProps = {
  token: TokenInfo;
  chainId: number;
  size?: TokenBadgeSize;
  bare?: boolean;
  // Picker rows pass true so off-screen coins don't stampede /api/icon.
  lazy?: boolean;
};

export function TokenIcon(props: TokenIconProps) {
  const cacheKey = iconKey(props.chainId, props.token.address);
  // Remount on key change: React reuses a row's component instance for a
  // different token as the list filters, and the fallback cursor has to
  // restart with it (no effect-based reset needed this way).
  return <TokenIconInner key={cacheKey} cacheKey={cacheKey} {...props} />;
}

function TokenIconInner({
  token,
  chainId,
  size = "md",
  bare = false,
  lazy = false,
  cacheKey,
}: TokenIconProps & { cacheKey: string }) {
  const candidates = candidatesFor(token, chainId);
  const [src, setSrc] = React.useState<string | null>(() => {
    const peeked = peekIcon(cacheKey);
    return peeked !== undefined ? peeked : (candidates[0] ?? null);
  });

  React.useEffect(() => {
    let cancelled = false;
    void hydrateIconCache().then(() => {
      if (cancelled) return;
      const hit = peekIcon(cacheKey);
      if (hit !== undefined) setSrc(hit);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  const onLogoLoad = () => {
    if (src) void persistIconFromUrl(cacheKey, src);
  };

  const onLogoError = () => {
    if (src && src.startsWith("blob:")) {
      forgetIcon(cacheKey);
      setSrc(candidates[0] ?? null);
      return;
    }
    const next = src === null ? null : (candidates[candidates.indexOf(src) + 1] ?? null);
    rememberIcon(cacheKey, next);
    setSrc(next);
  };

  return (
    <TokenBadge
      ticker={token.symbol}
      logo={src}
      bare={bare}
      size={size}
      loading={lazy ? "lazy" : undefined}
      onLogoError={onLogoError}
      onLogoLoad={onLogoLoad}
    />
  );
}

import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  TokenHint,
} from "./types.ts";
import { UnsupportedChainError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { getReferralConfig } from "../referral.ts";

// OpenOcean Swap API v4. Two deployments share the same surface:
//
//   public:     https://open-api.openocean.finance/v4/{chain}/...  (2 rps)
//   pro:        https://open-api-pro.openocean.finance/v4/{chain}/...  (OPENOCEAN_API_KEY)
//
// The former key-gated host, open-api-enterprise.openocean.finance, returns
// 404 for every path since at least 2026-09-15; the docs still call the tier
// "Enterprise" but the host is open-api-pro.
//
// Public is keyless. Cloudflare 403s headerless CLI fetch with a JS
// challenge; Origin+Referer matching the web app is enough for Bun's
// fetch to get JSON (measured 2026-09-08). An OPENOCEAN_API_KEY switches
// to the pro host (`apikey` header) and drops those headers.
//
// Docs: https://docs.openocean.finance/docs/swap-api/api-pricing-and-access
// (public) and /enterprise.
//
// API quirks vs. the other aggregators we wire up:
//   - We use the new `amountDecimals` (wei string) + `gasPriceDecimals`
//     (gas price in wei) params. The legacy `amount` (human-units) +
//     `gasPrice` (gwei) params are deprecated per OpenOcean's docs.
//   - `slippage` is in **percent** (1 = 1%, 0.1 = 0.1%) — translate
//     from bps. Range 0.05–50.
//   - `referrerFee` is also in percent (e.g. 0.5 = 0.5%). OpenOcean
//     itself caps the fee at 5% (500 bps); we clamp to that on send
//     so a higher REFERRAL_FEE_BPS doesn't trip a 400. They keep 20%
//     of the collected fee by default.
//   - Native token sentinel is the same `0xeeee…eeee` we already use
//     internally, so no translation needed.

const OPENOCEAN_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// Placeholder gas price (= 1 gwei in wei) sent as `gasPriceDecimals`.
// Required by the v4 schema even on /quote, but only feeds OpenOcean's
// internal route-vs-gas-cost heuristic — we re-compute gas USD via
// our own gas_usd.ts pipeline regardless. Bumping it would push their
// router toward fewer-hop paths.
const OPENOCEAN_GAS_PRICE_PLACEHOLDER_WEI = "1000000000";

// Per-chain short code used in the URL path. We could also pass the
// numeric chainId — both are accepted — but the short codes are what
// the docs use, and it keeps URLs readable when debugging.
const OPENOCEAN_CHAIN_CODE: Record<number, string> = {
  1: "eth",
  56: "bsc",
  100: "xdai", // "gnosis" is rejected by the API (verified 2026-09-09)
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  // Numeric /v4/4663 returns 500; the slug is the working path.
  4663: "robinhood",
};

// OpenOcean's own cap on partner fees, per their docs (range 0.01%
// to 5%). Our global REFERRAL_FEE_BPS is clamped to [0, 1000]; this
// venue clamps further to 500 (5%).
const OPENOCEAN_FEE_BPS_MAX = 500;

type OOToken = {
  address: string;
  symbol: string;
  name?: string;
  decimals?: number;
};

type OODex = {
  dex: string;
  id?: string;
  parts?: number;
  percentage?: number;
  fee?: number;
};

type OOSubRoute = {
  from: string;
  to: string;
  parts?: number;
  dexes?: OODex[];
};

type OORoute = {
  parts?: number;
  percentage?: number;
  subRoutes?: OOSubRoute[];
};

type OOPath = {
  from?: string;
  to?: string;
  parts?: number;
  routes?: OORoute[];
};

type OOQuoteResponse = {
  code?: number;
  message?: string;
  error?: string;
  data?: {
    inToken?: OOToken;
    outToken?: OOToken;
    inAmount?: string;
    outAmount?: string;
    estimatedGas?: string | number;
    minOutAmount?: string;
    // Route price impact, e.g. "-0.14%" (string with a % suffix) or a
    // bare number. Negative = adverse (the usual case). Crucially,
    // OpenOcean's `outAmount` is a mid-price estimate that does NOT
    // include this impact, so we apply it ourselves — see normalizeOut.
    price_impact?: string | number;
    path?: OOPath;
    // Present on /swap responses only.
    from?: string;
    to?: string;
    value?: string;
    data?: string;
    gasPrice?: string;
  };
};

// OpenOcean's `outAmount` is a mid-price estimate that does NOT fold in
// the route's price impact: the on-chain execution actually delivers
// ~`outAmount × (1 + price_impact/100)` (price_impact is negative for the
// usual adverse case). Every other aggregator we wire up already bakes
// impact into its quoted output, so OpenOcean was the lone venue whose
// headline quote *systematically* overstated what the user receives — by
// ~1 bp on deep stable pairs up to ~10+ bp on volatile ones. That both
// surprised users at execution and inflated OpenOcean's rank in the
// `-v all` comparison (pickBest sorts on gross amountOut). Folding the
// impact in here moved the simulated quote-vs-received bias from a
// consistent ~-10 bp down to a median ~0 across the test matrix.
//
// On deep/stable routes price_impact is essentially exact (a "-0.01%"
// impact on a 10k USDC→USDT swap matched a -0.01% simulated shortfall to
// the wei). On some volatile routes OpenOcean *understates* its own
// impact (e.g. it reports "+0.02%" while execution loses ~10 bp), so the
// correction only removes the part OpenOcean admits to — but it never
// makes things worse, and the residual is then in line with the other
// aggregators' own volatile-pair estimate error (a few bp).
//
// Guard rails: only ever *reduce* the amount (never inflate on a rare
// positive impact — displaying a conservative number is the safe
// direction), and bail back to the raw figure on an unparseable or
// implausible (>100%) impact.
function parsePriceImpactPct(pi: string | number | undefined | null): number | null {
  if (pi === undefined || pi === null) return null;
  if (typeof pi === "number") return Number.isFinite(pi) ? pi : null;
  const n = Number(pi.trim().replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function applyPriceImpact(
  outAmount: string,
  priceImpact: string | number | undefined | null,
): string {
  const pct = parsePriceImpactPct(priceImpact);
  // Only correct adverse (negative) impact — never inflate the quote.
  if (pct === null || pct >= 0) return outAmount;
  const SCALE = 100_000_000n; // 1e8 fixed-point on the (1 + pct/100) factor
  const factor = SCALE + BigInt(Math.round((pct / 100) * 1e8));
  if (factor <= 0n) return outAmount; // implausible >100% impact — bail
  let out: bigint;
  try {
    out = BigInt(outAmount);
  } catch {
    return outAmount;
  }
  return ((out * factor) / SCALE).toString();
}

// Partner-fee deduction for the quote side.
//
// `referrerFee` is a percentage charged on the trade. OpenOcean reports it as a
// straight reduction of the quoted output: verified live 2026-08-09 on
// eth WETH→USDC, `outAmount` came back at exactly ×0.99 for referrerFee=1 and
// ×0.995 for referrerFee=0.5, on both /quote and /swap. (On-chain the fee is
// actually pulled on the *input* token — an eth_simulateV1 prank at 50 bps
// showed a 0.04 WETH Transfer to REFERRAL_ADDRESS, i.e. the referrer's 80%
// share, OpenOcean keeping the rest — but the venue prices it as an output
// reduction, and displaying the full percentage is the conservative direction.)
//
// We deduct it locally instead of sending `referrer`/`referrerFee` to /quote
// because OpenOcean *also* folds the fee into `price_impact` (-0.04% → -1.04%
// at referrerFee=1), and applyPriceImpact would then charge it a second time.
// Deducting after applyPriceImpact gives exactly gross × (1 + impact) × (1 −
// fee), i.e. one impact and one fee. feeBps is clamped the same way buildTx
// clamps it, so the displayed deduction always matches what /swap is sent.
function applyReferrerFee(outAmount: string): {
  amountOut: string;
  protocolFee: { raw: string; sharePct: number; side: "in" | "out" } | null;
} {
  const ref = getReferralConfig();
  if (!ref.address || ref.feeBps <= 0) return { amountOut: outAmount, protocolFee: null };
  const feeBps = BigInt(Math.min(ref.feeBps, OPENOCEAN_FEE_BPS_MAX));
  const gross = BigInt(outAmount);
  const net = (gross * (10_000n - feeBps)) / 10_000n;
  const fee = gross - net;
  if (fee <= 0n) return { amountOut: outAmount, protocolFee: null };
  const sharePct =
    net > 0n ? Number((fee * 100_000_000n) / net) / 1_000_000 : 0;
  return {
    amountOut: net.toString(),
    protocolFee: { raw: fee.toString(), sharePct, side: "out" },
  };
}

function toOOAddr(addr: string): string {
  return addr.toLowerCase() === NATIVE_SENTINEL
    ? OPENOCEAN_NATIVE
    : addr.toLowerCase();
}

function fromOOAddr(addr: string): string {
  return addr.toLowerCase() === OPENOCEAN_NATIVE
    ? NATIVE_SENTINEL
    : addr.toLowerCase();
}

const OPENOCEAN_PUBLIC_BASE = "https://open-api.openocean.finance";
const OPENOCEAN_PRO_BASE = "https://open-api-pro.openocean.finance";
// Cloudflare on the public host allowlists the web app origin. Without
// both headers, bun fetch gets a 403 HTML challenge instead of JSON.
const OPENOCEAN_PUBLIC_ORIGIN = "https://app.openocean.finance";

export type OpenoceanConfig = {
  base: string;
  apiKey: string | null;
};

export function openoceanConfig(): OpenoceanConfig {
  const apiKey = process.env.OPENOCEAN_API_KEY?.trim() || null;
  return {
    base: apiKey ? OPENOCEAN_PRO_BASE : OPENOCEAN_PUBLIC_BASE,
    apiKey,
  };
}

function requestHeaders(cfg: OpenoceanConfig): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (cfg.apiKey) {
    h.apikey = cfg.apiKey;
    return h;
  }
  h.origin = OPENOCEAN_PUBLIC_ORIGIN;
  h.referer = `${OPENOCEAN_PUBLIC_ORIGIN}/`;
  return h;
}

function buildHops(args: {
  path: OOPath | undefined;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}): NormalizedHop[] {
  const hops: NormalizedHop[] = [];
  const routes = args.path?.routes ?? [];
  for (const route of routes) {
    // Top-level routes are split across by percentage (0..100). Use it
    // to size the swapAmount displayed for each subRoute hop — only
    // the first hop in a sub-route really swaps that share of
    // amountIn; downstream hops swap whatever the previous hop
    // produced, which we don't have visibility into. Format.ts groups
    // by hop.tokenIn so the "split on X" tree still renders sensibly.
    const pct = route.percentage ?? 100;
    const routeAmount =
      (args.amountIn * BigInt(Math.round(pct * 100))) / 10000n;
    const subs = route.subRoutes ?? [];
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i]!;
      const dexNames = (sub.dexes ?? []).map((d) => d.dex).join(",") || "openocean";
      // Use the dex's pool fee on single-dex sub-routes for the v3-style
      // fee label in the route tree.
      const singleDex = sub.dexes?.length === 1 ? sub.dexes[0]! : null;
      const feeHint =
        singleDex && typeof singleDex.fee === "number" ? singleDex.fee : undefined;
      hops.push({
        tokenIn: fromOOAddr(sub.from ?? args.tokenIn),
        tokenOut: fromOOAddr(sub.to ?? args.tokenOut),
        exchange: dexNames,
        // Only the first hop in a chain really swaps routeAmount (a share of
        // amountIn, in the route input token's units). Downstream hops swap
        // whatever the previous hop produced — OpenOcean doesn't expose that,
        // so reuse routeAmount as a relative weight for the "split on X"
        // percentages and flag it approxAmount so renderers never show it as
        // an absolute amount (it is NOT denominated in this hop's tokenIn).
        swapAmount: routeAmount.toString(),
        approxAmount: i > 0 || undefined,
        fee: feeHint,
      });
    }
  }
  return hops;
}

function collectTokenHints(data: OOQuoteResponse["data"]): Map<string, TokenHint> {
  const hints = new Map<string, TokenHint>();
  const add = (t: OOToken | undefined) => {
    if (!t || !t.address) return;
    const lower = t.address.toLowerCase() === OPENOCEAN_NATIVE
      ? NATIVE_SENTINEL
      : t.address.toLowerCase();
    if (t.symbol && typeof t.decimals === "number") {
      hints.set(lower, {
        symbol: t.symbol,
        name: t.name ?? t.symbol,
        decimals: t.decimals,
      });
    }
  };
  add(data?.inToken);
  add(data?.outToken);
  return hints;
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn, slippageBps } = params;

  const cfg = openoceanConfig();
  const code = OPENOCEAN_CHAIN_CODE[chain.chainId];
  if (!code) throw new UnsupportedChainError("openocean", chain.displayName);

  const url = new URL(`${cfg.base}/v4/${code}/quote`);
  url.searchParams.set("inTokenAddress", toOOAddr(tokenIn));
  url.searchParams.set("outTokenAddress", toOOAddr(tokenOut));
  url.searchParams.set("amountDecimals", amountIn.toString());
  url.searchParams.set("slippage", (slippageBps / 100).toString());
  url.searchParams.set(
    "gasPriceDecimals",
    OPENOCEAN_GAS_PRICE_PLACEHOLDER_WEI,
  );

  const res = await venueFetch(url.toString(), {
    headers: requestHeaders(cfg),
  });
  const json = await parseJsonOrWarn<OOQuoteResponse>(res, "openocean /quote");
  if (!res.ok || json.code !== 200 || !json.data?.outAmount) {
    const reason =
      json.message || json.error || `${res.status} ${res.statusText}`;
    throw new Error(`openocean: ${reason}`);
  }

  const d = json.data;
  // Fold the route's price impact into the headline amount so the quote
  // reflects the executable receivable, not OpenOcean's pre-impact
  // mid-price estimate (see applyPriceImpact for the why + evidence).
  const outAmount = applyPriceImpact(d.outAmount!, d.price_impact);
  // Then net out the partner fee the build will charge (no-op when
  // REFERRAL_FEE_BPS is 0 / unset) — see applyReferrerFee.
  const net = applyReferrerFee(outAmount);
  return {
    venue: "openocean",
    amountIn: d.inAmount ?? amountIn.toString(),
    amountOut: net.amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: toNumOrNull(d.estimatedGas ?? null),
    gasPriceWei: null,
    gasUsd: null,
    router: null,
    hops: buildHops({
      path: d.path,
      tokenIn,
      tokenOut,
      amountIn,
    }),
    tokenHints: collectTokenHints(d),
    protocolFee: net.protocolFee,
    raw: json,
  };
}

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;

  const cfg = openoceanConfig();
  const code = OPENOCEAN_CHAIN_CODE[chain.chainId];
  if (!code) throw new UnsupportedChainError("openocean", chain.displayName);

  const url = new URL(`${cfg.base}/v4/${code}/swap`);
  url.searchParams.set("inTokenAddress", toOOAddr(tokenIn));
  url.searchParams.set("outTokenAddress", toOOAddr(tokenOut));
  url.searchParams.set("amountDecimals", amountIn.toString());
  url.searchParams.set("slippage", (slippageBps / 100).toString());
  url.searchParams.set(
    "gasPriceDecimals",
    OPENOCEAN_GAS_PRICE_PLACEHOLDER_WEI,
  );
  url.searchParams.set("account", sender);

  const ref = getReferralConfig();
  if (ref.address && ref.feeBps > 0) {
    const clamped = Math.min(ref.feeBps, OPENOCEAN_FEE_BPS_MAX);
    url.searchParams.set("referrer", ref.address);
    url.searchParams.set("referrerFee", (clamped / 100).toString());
  }

  const res = await venueFetch(url.toString(), {
    headers: requestHeaders(cfg),
  });
  const json = await parseJsonOrWarn<OOQuoteResponse>(res, "openocean /swap");
  if (!res.ok || json.code !== 200 || !json.data?.to || !json.data?.data) {
    const reason =
      json.message || json.error || `${res.status} ${res.statusText}`;
    throw new Error(`openocean build: ${reason}`);
  }

  const tx = json.data;
  return {
    to: tx.to!,
    from: sender,
    data: tx.data!,
    value: tx.value ?? "0",
    gas: tx.estimatedGas ? String(tx.estimatedGas) : null,
    gasPrice: tx.gasPrice ?? null,
    maxPriorityFeePerGas: null,
    spender: tx.to!,
    chainId: chain.chainId,
  };
}

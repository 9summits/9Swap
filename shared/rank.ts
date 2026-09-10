export type TradeSide = "sell" | "buy";

export type Execution =
  | { kind: "async" }
  | { kind: "sync"; gasUnits: number | null; gasPriceWei: string | null };

export type RankQuote = {
  amountIn: string;
  amountOut: string;
  /**
   * Sell-side guaranteed floor when `amountOut` is optimistic (Fusion auction
   * end). Ranking uses this instead of amountOut when present.
   */
  minAmountOut?: string;
  execution: Execution;
};

/** Sell rank key: guaranteed min when the venue exposes one, else the cote. */
export function sellAmountOutForRank(q: {
  amountOut: string;
  minAmountOut?: string;
}): string {
  return q.minAmountOut ?? q.amountOut;
}

export type RankMode =
  | { readonly mode: "gross" }
  | {
      readonly mode: "net";
      readonly nativeScaled: bigint;
      readonly tokenScaled: bigint;
      readonly tokenDecimals: number;
    };

export const GROSS: RankMode = { mode: "gross" };

export type UserGas =
  | { readonly kind: "zero" }
  | { readonly kind: "wei"; readonly wei: bigint }
  | { readonly kind: "unknown" };

export type FetchedUsd = {
  nativeUsd: number | null;
  tokenInUsd: number | null;
  tokenOutUsd: number | null;
};

const USD_SCALE = 10n ** 8n;

function scaleUsd(usd: number): bigint | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const n = usd * Number(USD_SCALE);
  if (!Number.isFinite(n) || n <= 0) return null;
  const scaled = BigInt(Math.round(n));
  return scaled > 0n ? scaled : null;
}

function validDecimals(d: number): boolean {
  return Number.isInteger(d) && d >= 0 && d <= 255;
}

export function rankModeFromPrices(p: {
  nativeUsd: number;
  tokenUsd: number;
  tokenDecimals: number;
}): RankMode {
  if (!validDecimals(p.tokenDecimals)) return GROSS;
  const nativeScaled = scaleUsd(p.nativeUsd);
  const tokenScaled = scaleUsd(p.tokenUsd);
  if (nativeScaled === null || tokenScaled === null) return GROSS;
  return {
    mode: "net",
    nativeScaled,
    tokenScaled,
    tokenDecimals: p.tokenDecimals,
  };
}

export function rankModeFromFetched(
  p: FetchedUsd & {
    side: TradeSide;
    tokenInDecimals: number;
    tokenOutDecimals: number;
  },
): RankMode {
  const tokenUsd = p.side === "sell" ? p.tokenOutUsd : p.tokenInUsd;
  const tokenDecimals = p.side === "sell" ? p.tokenOutDecimals : p.tokenInDecimals;
  if (p.nativeUsd == null || tokenUsd == null) return GROSS;
  return rankModeFromPrices({
    nativeUsd: p.nativeUsd,
    tokenUsd,
    tokenDecimals,
  });
}

export function toExecution(
  kind: "sync" | "async",
  gasUnits: number | null,
  gasPriceWei: string | null,
): Execution {
  if (kind === "async") return { kind: "async" };
  return { kind: "sync", gasUnits, gasPriceWei };
}

export function toRankQuote(
  q: {
    amountIn: string;
    amountOut: string;
    minAmountOut?: string;
    gasUnits: number | null;
    gasPriceWei: string | null;
  },
  isAsync: boolean,
): RankQuote {
  return {
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    ...(q.minAmountOut ? { minAmountOut: q.minAmountOut } : {}),
    execution: toExecution(
      isAsync ? "async" : "sync",
      q.gasUnits,
      q.gasPriceWei,
    ),
  };
}

export function userGasNative(execution: Execution): UserGas {
  if (execution.kind === "async") return { kind: "zero" };
  const units = execution.gasUnits;
  const price = execution.gasPriceWei;
  if (units == null || price == null) return { kind: "unknown" };
  if (!Number.isInteger(units) || units <= 0) return { kind: "unknown" };
  let weiPrice: bigint;
  try {
    weiPrice = BigInt(price);
  } catch {
    return { kind: "unknown" };
  }
  if (weiPrice <= 0n) return { kind: "unknown" };
  const product = BigInt(units) * weiPrice;
  if (product <= 0n) return { kind: "unknown" };
  return { kind: "wei", wei: product };
}

function gasHaircut(
  gasWei: bigint,
  rank: Extract<RankMode, { mode: "net" }>,
): bigint {
  // 10n ** 18n is wei-per-native, not a token decimal.
  return (
    (gasWei * 10n ** BigInt(rank.tokenDecimals) * rank.nativeScaled) /
    (rank.tokenScaled * 10n ** 18n)
  );
}

export function rankAmount(
  q: RankQuote,
  side: TradeSide,
  rank: RankMode,
): string {
  const gross = side === "buy" ? q.amountIn : sellAmountOutForRank(q);
  if (rank.mode === "gross") return gross;
  const gas = userGasNative(q.execution);
  if (gas.kind === "unknown") return "";
  if (gas.kind === "zero") return gross;
  try {
    const cut = gasHaircut(gas.wei, rank);
    if (side === "sell") return (BigInt(sellAmountOutForRank(q)) - cut).toString();
    return (BigInt(q.amountIn) + cut).toString();
  } catch {
    return "";
  }
}

export function effectiveRank(
  quotes: readonly RankQuote[],
  rank: RankMode,
): RankMode {
  if (rank.mode !== "net") return rank;
  for (const q of quotes) {
    const g = userGasNative(q.execution);
    if (g.kind === "zero" || g.kind === "wei") return rank;
  }
  return GROSS;
}

export function positiveAmount(s: string): bigint | null {
  try {
    const v = BigInt(s);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function compareBySide(a: string, b: string, side: TradeSide): number {
  const A = positiveAmount(a);
  const B = positiveAmount(b);
  if (A === null && B === null) return 0;
  if (A === null) return 1;
  if (B === null) return -1;
  if (side === "buy") {
    return A < B ? -1 : A > B ? 1 : 0;
  }
  return A > B ? -1 : A < B ? 1 : 0;
}

export function sortRoutesBySide<T extends RankQuote>(
  routes: readonly T[],
  side: TradeSide,
  rank: RankMode,
): T[] {
  const mode = effectiveRank(routes, rank);
  const copy = routes.slice();
  copy.sort((a, b) => {
    const primary = compareBySide(
      rankAmount(a, side, mode),
      rankAmount(b, side, mode),
      side,
    );
    if (primary !== 0) return primary;
    if (side === "buy") {
      return compareBySide(a.amountOut, b.amountOut, "sell");
    }
    return 0;
  });
  return copy;
}

export function rankRoutesBySide<T extends RankQuote>(
  routes: readonly T[],
  side: TradeSide,
  rank: RankMode,
): T[] {
  return sortRoutesBySide(routes, side, rank);
}

export function netUsdOf(
  q: RankQuote,
  side: TradeSide,
  rank: RankMode,
): number | null {
  if (rank.mode !== "net") return null;
  const gas = userGasNative(q.execution);
  if (gas.kind === "unknown") return null;
  const amount = side === "buy" ? q.amountIn : sellAmountOutForRank(q);
  const pos = positiveAmount(amount);
  if (pos === null) return null;
  const human = Number(pos) / 10 ** rank.tokenDecimals;
  const tokenUsd = Number(rank.tokenScaled) / Number(USD_SCALE);
  const nativeUsd = Number(rank.nativeScaled) / Number(USD_SCALE);
  const gasNative = gas.kind === "zero" ? 0 : Number(gas.wei) / 1e18;
  if (![human, tokenUsd, nativeUsd, gasNative].every(Number.isFinite)) {
    return null;
  }
  const net =
    side === "buy"
      ? human * tokenUsd + gasNative * nativeUsd
      : human * tokenUsd - gasNative * nativeUsd;
  return Number.isFinite(net) ? net : null;
}

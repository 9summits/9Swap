import type { ChainInfo } from "./chains.ts";
import type { Token } from "./tokens.ts";
import type { NormalizedQuote, TokenHint } from "./venues/index.ts";
import { fromBaseUnits } from "./amount.ts";
import { combinedLabels } from "./format.ts";

type JsonHop = {
  exchange: string;
  pool: string | null;
  /** Fee in hundredths of a bp (100 = 0.01%, 500 = 0.05%, 3000 = 0.3%, 10000 = 1%). Null if the venue doesn't expose it. */
  feeHundredthsOfBp: number | null;
  feePct: number | null;
  swapAmountRaw: string;
  // True when swapAmountRaw is only a split weight denominated in the route
  // input token (not tokenIn) — openocean / 1inch downstream hops.
  swapAmountApprox: boolean;
  // Hop output in tokenOut base units; null when the venue doesn't report it.
  amountOutRaw: string | null;
  sharePct: number | null;
  tokenIn: { address: string; symbol: string };
  tokenOut: { address: string; symbol: string };
};

type JsonSplit = {
  tokenIn: { address: string; symbol: string };
  totalSwapAmountRaw: string;
  hops: JsonHop[];
};

export function toJson(args: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  quote: NormalizedQuote;
  intermediaries: Map<string, TokenHint>;
}): unknown {
  const { chain, tokenIn, tokenOut, quote, intermediaries } = args;

  const labels = combinedLabels(tokenIn, tokenOut, quote, intermediaries);
  const sym = (addr: string): string => {
    const a = addr.toLowerCase();
    return labels.get(a) ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
  };

  const amountInHuman = fromBaseUnits(quote.amountIn, tokenIn.decimals, 12);
  const amountOutHuman = fromBaseUnits(quote.amountOut, tokenOut.decimals, 12);

  const inUsd = quote.amountInUsd;
  const outUsd = quote.amountOutUsd;

  const rate = safeDiv(Number(amountOutHuman), Number(amountInHuman));
  const inverseRate = rate && rate > 0 ? 1 / rate : null;
  const priceImpactPct =
    inUsd !== null && outUsd !== null && inUsd > 0
      ? ((outUsd - inUsd) / inUsd) * 100
      : null;

  const gasPriceGwei = quote.gasPriceWei
    ? Number(BigInt(quote.gasPriceWei)) / 1e9
    : null;

  const groups = new Map<string, JsonHop[]>();
  for (const h of quote.hops) {
    const key = h.tokenIn.toLowerCase();
    const entry: JsonHop = {
      exchange: h.exchange,
      pool: h.pool ?? null,
      feeHundredthsOfBp: h.fee ?? null,
      feePct: h.fee !== undefined ? h.fee / 10_000 : null,
      swapAmountRaw: h.swapAmount,
      swapAmountApprox: h.approxAmount ?? false,
      amountOutRaw: h.amountOut ?? null,
      sharePct: null,
      tokenIn: { address: key, symbol: sym(key) },
      tokenOut: {
        address: h.tokenOut.toLowerCase(),
        symbol: sym(h.tokenOut),
      },
    };
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }

  const splits: JsonSplit[] = [];
  for (const [key, hops] of groups) {
    const total = hops.reduce(
      (a, h) => a + BigInt(h.swapAmountRaw || "0"),
      0n,
    );
    for (const h of hops) {
      h.sharePct =
        total > 0n
          ? Number((BigInt(h.swapAmountRaw || "0") * 10000n) / total) / 100
          : null;
    }
    splits.push({
      tokenIn: { address: key, symbol: sym(key) },
      totalSwapAmountRaw: total.toString(),
      hops,
    });
  }

  return {
    venue: quote.venue,
    chain: {
      alias: chain.alias,
      chainId: chain.chainId,
      name: chain.displayName,
    },
    tokenIn: {
      address: tokenIn.address,
      symbol: tokenIn.symbol,
      name: tokenIn.name,
      decimals: tokenIn.decimals,
      source: tokenIn.source,
    },
    tokenOut: {
      address: tokenOut.address,
      symbol: tokenOut.symbol,
      name: tokenOut.name,
      decimals: tokenOut.decimals,
      source: tokenOut.source,
    },
    amountIn: { raw: quote.amountIn, human: amountInHuman, usd: inUsd },
    amountOut: { raw: quote.amountOut, human: amountOutHuman, usd: outUsd },
    ...(quote.minAmountOut
      ? {
          minAmountOut: {
            raw: quote.minAmountOut,
            human: fromBaseUnits(quote.minAmountOut, tokenOut.decimals, 12),
          },
        }
      : {}),
    rate,
    inverseRate,
    priceImpactPct,
    gas: {
      units: quote.gasUnits,
      priceWei: quote.gasPriceWei,
      priceGwei: gasPriceGwei,
      usd: quote.gasUsd,
    },
    protocolFee: quote.protocolFee
      ? (() => {
          const feeToken =
            quote.protocolFee.side === "in" ? tokenIn : tokenOut;
          return {
            raw: quote.protocolFee.raw,
            human: fromBaseUnits(
              quote.protocolFee.raw,
              feeToken.decimals,
              12,
            ),
            symbol: feeToken.symbol,
            side: quote.protocolFee.side,
            sharePct: quote.protocolFee.sharePct,
          };
        })()
      : null,
    router: quote.router,
    route: splits,
  };
}

function safeDiv(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

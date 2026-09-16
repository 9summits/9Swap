// Display-only fill for `quote.gasUsd` when the venue's API didn't
// return one (matcha, 1inch, curve at quote-time):
//
//   gasUsd = gasUnits × gasPriceWei × NATIVE_USD / 1e18
//
// ETH_USD=$2000 is a label for the gas column, not a ranking input.
// Ranking reads gasUnits and gasPriceWei via ensureGasNative instead.
//
// gasPriceWei comes from the venue's quote response when available
// (avoids an extra RPC roundtrip), otherwise from `eth_gasPrice` on the
// chain's RPC. The result is memoized per (chain, runtime) so the
// price call fires at most once per CLI invocation across all venues.

import type { ChainInfo } from "./chains.ts";
import type { NormalizedQuote, VenueResult } from "./venues/index.ts";
import { isAsyncVenue } from "./venues/types.ts";
import { getGasPrice, tryRpcUrl } from "./rpc.ts";

// Hardcoded native-token USD spot. Quote-time ETH price is irrelevant
// for venue comparison (gas cost in USD across venues all scale with
// the same constant) so a fixed assumption is fine. Bump when ETH
// drifts a lot. Override per-chain below where needed.
const ETH_USD = 2000;

function nativeUsdFor(chain: ChainInfo): number | null {
  // Most supported chains settle in ETH; a few have their own native
  // (BNB, AVAX, HYPE). For non-ETH natives we don't guess — leave
  // gasUsd null and let the renderer show "—".
  if (chain.nativeSymbol === "ETH") return ETH_USD;
  // Arc pays gas in USDC — the native price is $1 by construction, no
  // hardcoded spot needed (and the gas column is meaningful there).
  if (chain.nativeSymbol === "USDC") return 1;
  return null;
}

const gasPriceCache = new Map<number, Promise<bigint | null>>();

async function gasPriceFor(chain: ChainInfo): Promise<bigint | null> {
  let p = gasPriceCache.get(chain.chainId);
  if (p) return p;
  p = (async () => {
    const rpc = tryRpcUrl(chain);
    if (!rpc) return null;
    return getGasPrice(rpc);
  })();
  gasPriceCache.set(chain.chainId, p);
  return p;
}

// Heuristic gas estimate for curve. curve-js doesn't expose a
// quote-time estimate so the adapter leaves `gasUnits` null; we
// rebuild a sensible figure from the route shape (each hop's pool
// kind plus a RouterNG overhead for multi-hop). Numbers are calibrated
// from observed on-chain swaps; ±20% accuracy, fine for the
// comparison block's ordering.
export function estimateCurveGasUnits(
  hops: { exchange: string }[],
): number | null {
  if (!hops.length) return null;
  let total = 0;
  for (const hop of hops) {
    // exchange labels come from curve.ts labelForPoolId():
    //   "Curve StableSwap NG"  / "Curve crvUSD pool" / "Curve Factory Stable" → stable
    //   "Curve TwoCrypto NG"   / "Curve TriCrypto NG" / "Curve Factory Crypto" → crypto
    // Cryptoswap is heavier than stableswap (more on-chain math).
    const isCrypto = /crypto/i.test(hop.exchange);
    total += isCrypto ? 220_000 : 150_000;
  }
  // RouterNG wraps multi-hop routes; the wrapper itself burns ~50k
  // before delegating to each pool's exchange().
  if (hops.length > 1) total += 50_000;
  return total;
}

export function curveGasUsd(args: {
  hops: { exchange: string }[];
  nativeSymbol: string;
  gasPriceWei: bigint | null;
}): number | null {
  if (args.nativeSymbol !== "ETH") return null;
  if (args.gasPriceWei === null || args.gasPriceWei === 0n) return null;
  const gasUnits = estimateCurveGasUnits(args.hops);
  if (gasUnits === null) return null;
  const gasWei = BigInt(gasUnits) * args.gasPriceWei;
  const gasEth = Number(gasWei) / 1e18;
  return gasEth * ETH_USD;
}

export async function ensureGasNative(
  quote: NormalizedQuote,
  chain: ChainInfo,
): Promise<void> {
  if (isAsyncVenue(quote.venue)) return;
  if (quote.venue === "curve" && !quote.gasUnits) {
    const est = estimateCurveGasUnits(quote.hops);
    if (est !== null) quote.gasUnits = est;
  }
  if (!quote.gasUnits) return;
  if (quote.gasPriceWei) return;
  const fetched = await gasPriceFor(chain);
  if (fetched === null) return;
  quote.gasPriceWei = fetched.toString();
}

export async function fillGasUsd(
  quote: NormalizedQuote,
  chain: ChainInfo,
): Promise<void> {
  // Velora ships gasUsd with gasPriceWei null; ranking still needs wei.
  await ensureGasNative(quote, chain);
  if (quote.gasUsd !== null) return;
  if (!quote.gasUnits) return;
  const nativeUsd = nativeUsdFor(chain);
  if (nativeUsd === null) return;
  if (!quote.gasPriceWei) return;

  const gasPriceWei = BigInt(quote.gasPriceWei);
  const gasWei = BigInt(quote.gasUnits) * gasPriceWei;
  const gasEth = Number(gasWei) / 1e18;
  quote.gasUsd = gasEth * nativeUsd;
}

// Convenience over a VenueResult[] (the `-v all` case). Kicks off all
// fills in parallel; per-chain gas-price fetch is deduped via the
// cache above.
export async function fillGasUsdAll(
  results: VenueResult[],
  chain: ChainInfo,
): Promise<void> {
  await Promise.all(
    results.map((r) =>
      "quote" in r ? fillGasUsd(r.quote, chain) : Promise.resolve(),
    ),
  );
}

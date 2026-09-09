// Hop math must stay in sync with src/gas_usd.ts.

const ETH_USD = 2000;

export function estimateCurveGasUnits(
  hops: { exchange: string }[],
): number | null {
  if (!hops.length) return null;
  let total = 0;
  for (const hop of hops) {
    const isCrypto = /crypto/i.test(hop.exchange);
    total += isCrypto ? 220_000 : 150_000;
  }
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

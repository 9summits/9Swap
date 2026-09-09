import { test, expect } from "bun:test";
import {
  estimateCurveGasUnits,
  curveGasUsd,
} from "../src/gas_usd.ts";
import {
  estimateCurveGasUnits as webEstimateCurveGasUnits,
  curveGasUsd as webCurveGasUsd,
} from "../web/src/dapp/curve/gas.ts";

const hop = (exchange: string) => ({ exchange });

const fixtures: { name: string; hops: { exchange: string }[]; want: number | null }[] = [
  { name: "empty hops", hops: [], want: null },
  {
    name: "one stableswap hop",
    hops: [hop("Curve StableSwap NG")],
    want: 150_000,
  },
  {
    name: "one cryptoswap hop",
    hops: [hop("Curve TwoCrypto NG")],
    want: 220_000,
  },
  {
    name: "factory crypto hop",
    hops: [hop("Curve Factory Crypto")],
    want: 220_000,
  },
  {
    name: "crvUSD hop",
    hops: [hop("Curve crvUSD pool")],
    want: 150_000,
  },
  {
    name: "two stableswap hops plus RouterNG",
    hops: [hop("Curve StableSwap NG"), hop("Curve Factory Stable")],
    want: 150_000 * 2 + 50_000,
  },
  {
    name: "stable plus crypto plus RouterNG",
    hops: [hop("Curve StableSwap NG"), hop("Curve TwoCrypto NG")],
    want: 150_000 + 220_000 + 50_000,
  },
];

for (const f of fixtures) {
  test(f.name, () => {
    expect(estimateCurveGasUnits(f.hops)).toBe(f.want);
  });
}

test("/crypto/i is the hop discriminant", () => {
  expect(estimateCurveGasUnits([hop("Curve Factory Crypto")])).toBe(220_000);
  expect(estimateCurveGasUnits([hop("Curve Factory Stable")])).toBe(150_000);
  expect(estimateCurveGasUnits([hop("CRYPTO-ish pool")])).toBe(220_000);
});

test("curveGasUsd: 150k units at 1 gwei on ETH is 0.3", () => {
  expect(
    curveGasUsd({
      hops: [hop("Curve StableSwap NG")],
      nativeSymbol: "ETH",
      gasPriceWei: 1_000_000_000n,
    }),
  ).toBe(0.3);
});

test("curveGasUsd is null when native is not exact ETH", () => {
  expect(
    curveGasUsd({
      hops: [hop("Curve StableSwap NG")],
      nativeSymbol: "AVAX",
      gasPriceWei: 1_000_000_000n,
    }),
  ).toBeNull();
  expect(
    curveGasUsd({
      hops: [hop("Curve StableSwap NG")],
      nativeSymbol: "eth",
      gasPriceWei: 1_000_000_000n,
    }),
  ).toBeNull();
});

test("curveGasUsd is null when gasPriceWei is null or 0", () => {
  expect(
    curveGasUsd({
      hops: [hop("Curve StableSwap NG")],
      nativeSymbol: "ETH",
      gasPriceWei: null,
    }),
  ).toBeNull();
  expect(
    curveGasUsd({
      hops: [hop("Curve StableSwap NG")],
      nativeSymbol: "ETH",
      gasPriceWei: 0n,
    }),
  ).toBeNull();
});

test("web hop math matches CLI on the same fixtures", () => {
  for (const f of fixtures) {
    expect(webEstimateCurveGasUnits(f.hops)).toBe(estimateCurveGasUnits(f.hops));
  }
});

test("web curveGasUsd matches CLI on the same args", () => {
  const args = {
    hops: [hop("Curve StableSwap NG"), hop("Curve TwoCrypto NG")],
    nativeSymbol: "ETH",
    gasPriceWei: 2_000_000_000n,
  };
  expect(webCurveGasUsd(args)).toBe(curveGasUsd(args));
});

// Arc (5042) has no sentinel-native asset: the gas token is USDC, exposed
// through the ERC20 at 0x3600…0000 with 6 decimals while the EVM-level view
// (msg.value / eth_getBalance / gas) uses 18. Everything here must resolve to
// the ERC20 view — the 10^12 gap between the two is a calldata-corrupting bug.
// No network: every path below is satisfied by the builtin table.
import { describe, expect, test } from "bun:test";
import { CHAINS } from "../src/chains.ts";
import { NATIVE_SENTINEL, resolveToken, type Token } from "../src/tokens.ts";
import { detectWrap } from "../src/wrap.ts";
import { inputPaidViaValue, needsAllowanceCheck } from "../src/core.ts";
import { senderNativeBalanceOverride } from "../src/simulate.ts";

const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_EURC = "0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1";
const ARC_WETH = "0x128cc466b61f542da60c70e3aa11c10e19b84edb";

describe("Arc native symbol resolves to the ERC20, not the sentinel", () => {
  for (const input of ["USDC", "usdc"]) {
    test(`resolveToken("${input}")`, async () => {
      const t = await resolveToken(input, CHAINS.arc);
      expect(t.address).toBe(ARC_USDC);
      expect(t.decimals).toBe(6);
      expect(t.source).toBe("builtin");
      expect(t.chainId).toBe(5042);
    });
  }

  test("the sentinel address is rejected with a pointer to the ERC20", async () => {
    const err = await resolveToken(NATIVE_SENTINEL, CHAINS.arc).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(ARC_USDC);
    expect(err!.message).toContain("no separate native token");
  });

  test("regression: ETH on mainnet is still the 18-decimal sentinel", async () => {
    const t = await resolveToken("ETH", CHAINS.eth);
    expect(t.address).toBe(NATIVE_SENTINEL);
    expect(t.decimals).toBe(18);
    expect(t.source).toBe("native");
  });
});

describe("Arc has no wrap/unwrap short-circuit", () => {
  const pairs: Array<[string, string]> = [
    [ARC_USDC, ARC_WETH],
    [ARC_WETH, ARC_USDC],
    [NATIVE_SENTINEL, ARC_WETH],
    [ARC_WETH, NATIVE_SENTINEL],
  ];
  for (const [tokenInAddress, tokenOutAddress] of pairs) {
    test(`detectWrap(${tokenInAddress.slice(0, 8)} → ${tokenOutAddress.slice(0, 8)}) is null`, () => {
      expect(
        detectWrap({ chain: CHAINS.arc, tokenInAddress, tokenOutAddress }),
      ).toBeNull();
    });
  }
});

test("Arc USDC → EURC still needs an ERC20 allowance check", () => {
  const usdc: Token = {
    address: ARC_USDC,
    symbol: "USDC",
    name: "USDC",
    decimals: 6,
    chainId: 5042,
    source: "builtin",
  };
  expect(needsAllowanceCheck(usdc, "kyber", CHAINS.arc)).toBe(true);
  // Sanity: the EURC side is an ordinary ERC20 too.
  expect(
    needsAllowanceCheck({ ...usdc, address: ARC_EURC, symbol: "EURC" }, "kyber", CHAINS.arc),
  ).toBe(true);
});

describe("inputPaidViaValue — no approval when the router is paid natively", () => {
  // 10 USDC of Arc input carried as msg.value: 10e6 ERC20 units scaled by
  // 10^12 to the 18-decimal EVM view — the exact value Uniswap's Arc v4
  // build emits (0x8ac7230489e80000, verified live 2026-09-16).
  const VALUE_10_USDC = "10000000000000000000";
  const txBuild = (value: string) => ({ kind: "tx" as const, value });

  test("Arc USDC in, sync tx with a positive value → true", () => {
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, txBuild(VALUE_10_USDC))).toBe(true);
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, txBuild("100000000000000000000"))).toBe(true);
  });

  test("the address comparison is case-insensitive", () => {
    // Arc's own address is all digits, so exercise the casing rule on a
    // synthetic chain whose native ERC20 has letters in it.
    const mixed = { ...CHAINS.arc, nativeErc20: "0x3600000000000000000000000000000000000aBc" };
    expect(
      inputPaidViaValue(mixed, "0x3600000000000000000000000000000000000ABC", txBuild(VALUE_10_USDC)),
    ).toBe(true);
  });

  test("value 0 → false (kyber / 1inch / openocean pull via transferFrom)", () => {
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, txBuild("0"))).toBe(false);
  });

  test("a non-native Arc token with a positive value → false", () => {
    expect(inputPaidViaValue(CHAINS.arc, ARC_EURC, txBuild(VALUE_10_USDC))).toBe(false);
  });

  test("chains without a native ERC20 are never affected", () => {
    expect(inputPaidViaValue(CHAINS.eth, ARC_USDC, txBuild(VALUE_10_USDC))).toBe(false);
    expect(inputPaidViaValue(CHAINS.eth, NATIVE_SENTINEL, txBuild(VALUE_10_USDC))).toBe(false);
  });

  test("async orders and permit-tx builds never skip the approval", () => {
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, { kind: "order", value: VALUE_10_USDC })).toBe(false);
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, { kind: "permit-tx", value: VALUE_10_USDC })).toBe(false);
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, { kind: "order" })).toBe(false);
  });

  test("no build (quote only) → false", () => {
    expect(inputPaidViaValue(CHAINS.arc, ARC_USDC, null)).toBe(false);
  });
});

describe("simulate: sender balance override", () => {
  const GAS_BUDGET = 100n * 10n ** 18n;

  test("plain ERC20 input is funded by stateDiff — gas budget only", () => {
    expect(
      senderNativeBalanceOverride({ tokenInAmount: 10_000_000n, nativeInDecimals: null }),
    ).toBe(GAS_BUDGET);
  });

  test("sentinel native input adds amountIn 1:1", () => {
    const oneEth = 10n ** 18n;
    expect(
      senderNativeBalanceOverride({ tokenInAmount: oneEth, nativeInDecimals: 18 }),
    ).toBe(GAS_BUDGET + oneEth);
  });

  test("Arc USDC input is scaled by 10^12 to the EVM-level view", () => {
    // 10 USDC = 10e6 at the ERC20 view → 10e18 at the EVM view.
    expect(
      senderNativeBalanceOverride({ tokenInAmount: 10_000_000n, nativeInDecimals: 6 }),
    ).toBe(GAS_BUDGET + 10n * 10n ** 18n);
  });

  test("more than 18 decimals would scale down — refused loudly", () => {
    expect(() =>
      senderNativeBalanceOverride({ tokenInAmount: 1n, nativeInDecimals: 24 }),
    ).toThrow(/decimals/);
  });
});

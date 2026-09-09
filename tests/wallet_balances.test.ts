import { test, expect } from "bun:test";
import {
  collectBalanceTargets,
  pinHeldTokens,
} from "../web/src/dapp/tokenHoldings.ts";
import type { TokenInfo } from "../web/src/dapp/types.ts";

function tok(address: string, symbol: string, name = symbol, decimals = 18): TokenInfo {
  return { address, symbol, name, decimals };
}

function units(n: number | bigint, decimals: number): string {
  return (BigInt(n) * 10n ** BigInt(decimals)).toString();
}

const USDC = tok("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", "USD Coin");
const WETH = tok("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH");
const DAI = tok("0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI");
const CUSTOM = tok("0x1111111111111111111111111111111111111111", "CUSTOM");
const RECENT_ONLY = tok("0x2222222222222222222222222222222222222222", "RECENT");

test("collectBalanceTargets: curated first, then custom, then recent; first metadata wins", () => {
  const curatedDup = tok(USDC.address.toLowerCase(), "usdc-curated", "from curated");
  const customDup = tok(USDC.address, "USDC-CUSTOM", "from custom");
  const got = collectBalanceTargets({
    curated: [curatedDup, WETH],
    custom: [customDup, CUSTOM],
    recent: [USDC, RECENT_ONLY, WETH],
  });
  expect(got.map((t) => t.address.toLowerCase())).toEqual([
    USDC.address.toLowerCase(),
    WETH.address.toLowerCase(),
    CUSTOM.address.toLowerCase(),
    RECENT_ONLY.address.toLowerCase(),
  ]);
  expect(got[0]!.symbol).toBe("usdc-curated");
  expect(got[0]!.name).toBe("from curated");
});

test("collectBalanceTargets: custom-only and recent-only survive an empty curated list", () => {
  const got = collectBalanceTargets({
    curated: [],
    custom: [CUSTOM],
    recent: [RECENT_ONLY],
  });
  expect(got.map((t) => t.symbol)).toEqual(["CUSTOM", "RECENT"]);
});

test("pinHeldTokens: null map leaves every token in rest", () => {
  const tokens = [USDC, WETH, DAI];
  expect(pinHeldTokens({ tokens, balances: null })).toEqual({
    held: [],
    rest: tokens,
  });
});

test("pinHeldTokens: zero, missing, and garbage are not held", () => {
  const { held, rest } = pinHeldTokens({
    tokens: [USDC, WETH, DAI, CUSTOM],
    balances: {
      [USDC.address.toLowerCase()]: "0",
      [DAI.address.toLowerCase()]: "not-a-bigint",
      // WETH missing, CUSTOM > 0
      [CUSTOM.address.toLowerCase()]: units(1, 18),
    },
  });
  expect(held.map((t) => t.symbol)).toEqual(["CUSTOM"]);
  expect(rest.map((t) => t.symbol)).toEqual(["USDC", "WETH", "DAI"]);
});

test("pinHeldTokens: dust that formatUnits shows as 0 is not held", () => {
  const { held, rest } = pinHeldTokens({
    tokens: [WETH, DAI, USDC],
    balances: {
      [WETH.address.toLowerCase()]: "1",
      [DAI.address.toLowerCase()]: units(1, 18),
      [USDC.address.toLowerCase()]: "100",
    },
  });
  expect(held.map((t) => t.symbol)).toEqual(["DAI"]);
  expect(rest.map((t) => t.symbol)).toEqual(["WETH", "USDC"]);
});

test("pinHeldTokens: >0 pinned; relative order kept on both sides", () => {
  const tokens = [USDC, WETH, DAI, CUSTOM, RECENT_ONLY];
  const { held, rest } = pinHeldTokens({
    tokens,
    balances: {
      [DAI.address.toLowerCase()]: units(2, 18),
      [USDC.address.toLowerCase()]: units(1, 18),
      [RECENT_ONLY.address.toLowerCase()]: units(9, 18),
      [WETH.address.toLowerCase()]: "0",
    },
  });
  expect(held.map((t) => t.symbol)).toEqual(["USDC", "DAI", "RECENT"]);
  expect(rest.map((t) => t.symbol)).toEqual(["WETH", "CUSTOM"]);
});

test("pinHeldTokens: mixed-case address lookup", () => {
  const { held, rest } = pinHeldTokens({
    tokens: [USDC, WETH],
    balances: {
      [USDC.address.toLowerCase()]: units(100, 18),
    },
  });
  expect(held).toEqual([USDC]);
  expect(rest).toEqual([WETH]);
});

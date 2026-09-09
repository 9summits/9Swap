import { expect, test } from "bun:test";
import { builtinBySymbol, builtinTokens } from "../src/tokens_builtin.ts";
import { CHAINS } from "../src/chains.ts";

test("robinhood builtins start with WETH then USDG and cover the official registry", () => {
  const tokens = builtinTokens(4663);
  expect(tokens[0]?.symbol).toBe("WETH");
  expect(tokens[0]?.address.toLowerCase()).toBe(CHAINS.robinhood.wrappedNative.toLowerCase());
  expect(tokens[1]?.symbol).toBe("USDG");
  expect(tokens[1]?.decimals).toBe(6);
  expect(tokens.length).toBeGreaterThan(100);
});

test("robinhood USO keeps the historical CUSO alias", () => {
  const uso = builtinBySymbol(4663, "USO");
  const cuso = builtinBySymbol(4663, "CUSO");
  expect(uso).not.toBeNull();
  expect(cuso).toBe(uso);
});

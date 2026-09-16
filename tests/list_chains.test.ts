import { expect, test } from "bun:test";
import { listChains } from "../src/core.ts";

test("listChains pins eth, arc, base, robinhood, hype, ink then keeps remaining CHAINS order", () => {
  const aliases = listChains().map((c) => c.alias);
  expect(aliases.slice(0, 6)).toEqual(["eth", "arc", "base", "robinhood", "hype", "ink"]);
  expect(aliases).toEqual([
    "eth",
    "arc",
    "base",
    "robinhood",
    "hype",
    "ink",
    "arb",
    "op",
    "avax",
    "bsc",
    "unichain",
    "monad",
    "plasma",
    "polygon",
    "gnosis",
  ]);
});

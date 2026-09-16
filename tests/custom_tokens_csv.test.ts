// Pure CSV parse/serialize for the dApp custom-token manager.
// Does not touch localStorage — those helpers stay in customTokens.ts.
import { test, expect } from "bun:test";
import {
  parseCustomTokensCsv,
  storedCustomTokensFromUnknown,
  tokensToCsv,
  type CustomTokenCsvRow,
} from "../web/src/dapp/customTokensCsv.ts";

const USDC_ETH: CustomTokenCsvRow = {
  chain: "eth",
  symbol: "USDC",
  name: "USD Coin",
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  decimals: 6,
};

const WAVAX: CustomTokenCsvRow = {
  chain: "avax",
  symbol: "WAVAX",
  name: "Wrapped AVAX",
  address: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
  decimals: 18,
};

function roundTripRows(rows: CustomTokenCsvRow[]) {
  const parsed = parseCustomTokensCsv(tokensToCsv(rows));
  expect(parsed.errors).toEqual([]);
  expect(
    parsed.ok.map((r) => ({
      chain: r.chain,
      symbol: r.symbol,
      name: r.name,
      address: r.address,
      decimals: r.decimals,
    })),
  ).toEqual(
    rows.map((r) => ({
      ...r,
      address: r.address.toLowerCase(),
    })),
  );
  return parsed;
}

test("round-trip export then parse equals tokens (addresses lowercased)", () => {
  const mixedCase: CustomTokenCsvRow = {
    ...USDC_ETH,
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  };
  const parsed = roundTripRows([mixedCase, WAVAX]);
  expect(parsed.ok[0]!.address).toBe(USDC_ETH.address);
  expect(parsed.ok[0]!.chainId).toBe(1);
  expect(parsed.ok[1]!.chainId).toBe(43114);
});

test("header is required; extra columns ignored; blank lines skipped", () => {
  const csv = [
    "chain,symbol,name,address,decimals,note",
    "",
    `eth,USDC,USD Coin,${USDC_ETH.address},6,ignored`,
    "   ",
    `avax,WAVAX,Wrapped AVAX,${WAVAX.address},18`,
  ].join("\n");
  const parsed = parseCustomTokensCsv(csv);
  expect(parsed.errors).toEqual([]);
  expect(parsed.ok.map((r) => r.symbol)).toEqual(["USDC", "WAVAX"]);
});

test("quoted name with comma round-trips", () => {
  const row: CustomTokenCsvRow = {
    chain: "arb",
    symbol: "TOKEN",
    name: "Foo, Bar",
    address: "0x" + "ab".repeat(20),
    decimals: 8,
  };
  roundTripRows([row]);
});

test("unknown chain / bad address / empty fields are reported, not imported", () => {
  const csv = [
    "chain,symbol,name,address,decimals",
    "tac,USDC,USD Coin,0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,6",
    "eth,USDC,USD Coin,not-an-address,6",
    "eth,,USD Coin,0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,6",
    "eth,USDC,,0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,6",
  ].join("\n");
  const parsed = parseCustomTokensCsv(csv);
  expect(parsed.ok).toEqual([]);
  expect(parsed.errors.length).toBe(4);
  expect(parsed.errors[0]!.message).toContain("unknown chain");
  expect(parsed.errors[1]!.message).toContain("address");
  expect(parsed.errors[2]!.message).toContain("empty symbol");
  expect(parsed.errors[3]!.message).toContain("empty name");
});

test("never guesses decimals — missing, blank, float, or 18-coercion are errors", () => {
  const addr = USDC_ETH.address;
  const csv = [
    "chain,symbol,name,address,decimals",
    `eth,USDC,USD Coin,${addr},`,
    `eth,USDT,Tether,${addr}`,
    `eth,DAI,Dai,${addr},18.0`,
    `eth,BAD,Bad,${addr},37`,
    `eth,NEG,Neg,${addr},-1`,
  ].join("\n");
  const parsed = parseCustomTokensCsv(csv);
  expect(parsed.ok).toEqual([]);
  expect(parsed.errors.length).toBe(5);
  for (const err of parsed.errors) {
    expect(err.message.toLowerCase()).toContain("decimals");
  }
});

test("decimals 0 and 36 are accepted; header-only is empty ok", () => {
  const csv = [
    "chain,symbol,name,address,decimals",
    `eth,ZERO,Zero,${USDC_ETH.address},0`,
    `base,MAX,Max,${USDC_ETH.address},36`,
  ].join("\n");
  const parsed = parseCustomTokensCsv(csv);
  expect(parsed.errors).toEqual([]);
  expect(parsed.ok.map((r) => r.decimals)).toEqual([0, 36]);
  expect(parsed.ok[1]!.chainId).toBe(8453);

  const headerOnly = parseCustomTokensCsv("chain,symbol,name,address,decimals\n");
  expect(headerOnly.ok).toEqual([]);
  expect(headerOnly.errors).toEqual([]);
});

test("missing header fails the file", () => {
  const parsed = parseCustomTokensCsv("");
  expect(parsed.ok).toEqual([]);
  expect(parsed.errors[0]!.message).toContain("header");

  const noCols = parseCustomTokensCsv("foo,bar\neth,x\n");
  expect(noCols.ok).toEqual([]);
  expect(noCols.errors[0]!.message).toContain("missing header");
});

test("valid rows import alongside skipped bad rows", () => {
  const csv = [
    "chain,symbol,name,address,decimals",
    `eth,USDC,USD Coin,${USDC_ETH.address},6`,
    "eth,BAD,Bad,nope,6",
    `avax,WAVAX,Wrapped AVAX,${WAVAX.address},18`,
  ].join("\n");
  const parsed = parseCustomTokensCsv(csv);
  expect(parsed.ok.map((r) => r.symbol)).toEqual(["USDC", "WAVAX"]);
  expect(parsed.errors.length).toBe(1);
  expect(parsed.errors[0]!.line).toBe(3);
});

test("chain aliases are the CLI set", () => {
  const aliases = [
    "eth",
    "arb",
    "base",
    "op",
    "avax",
    "bsc",
    "hype",
    "unichain",
    "robinhood",
    "monad",
    "plasma",
    "polygon",
    "gnosis",
    "ink",
    "arc",
  ];
  const rows: CustomTokenCsvRow[] = aliases.map((chain, i) => ({
    chain,
    symbol: "T",
    name: "Token",
    address: "0x" + i.toString(16).padStart(2, "0").repeat(20),
    decimals: 18,
  }));
  const parsed = roundTripRows(rows);
  expect(parsed.ok.map((r) => r.chain)).toEqual(aliases);
});

test("storedCustomTokensFromUnknown reads numeric and alias keys", () => {
  const listed = storedCustomTokensFromUnknown({
    "1": [
      {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ],
    eth: [
      {
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        symbol: "WETH",
        name: "WETH",
        decimals: 18,
      },
    ],
  });
  expect(listed.map((r) => r.token.symbol).sort()).toEqual(["USDC", "WETH"]);
  expect(listed.every((r) => r.chainId === 1)).toBe(true);
  expect(listed.find((r) => r.token.symbol === "USDC")!.token.address).toBe(
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  );
});

test("storedCustomTokensFromUnknown skips corrupt rows without dropping the chain", () => {
  const listed = storedCustomTokensFromUnknown({
    "1": [
      { address: "not-an-address", symbol: "X", name: "X", decimals: 18 },
      { address: USDC_ETH.address, symbol: "USDC", name: "USD Coin", decimals: 6 },
      { address: USDC_ETH.address, symbol: "NOPE", name: "Nope" },
      null,
      "junk",
    ],
    nope: [{ address: USDC_ETH.address, symbol: "X", name: "X", decimals: 6 }],
  });
  expect(listed).toEqual([
    {
      chainId: 1,
      token: {
        address: USDC_ETH.address,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    },
  ]);
});

test("storedCustomTokensFromUnknown does not throw on missing symbol", () => {
  const listed = storedCustomTokensFromUnknown({
    "8453": [
      { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 },
    ],
  });
  expect(listed.length).toBe(1);
  expect(listed[0]!.chainId).toBe(8453);
  expect(listed[0]!.token.symbol.length).toBeGreaterThan(0);
});


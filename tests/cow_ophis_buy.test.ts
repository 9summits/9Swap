import { describe, expect, test } from "bun:test";
import {
  buildCowQuoteRequestBody,
  cowSignedOrderAmounts,
  normalizeCowQuoteAmounts,
} from "../src/venues/cow.ts";
import {
  buildOphisQuoteRequestBody,
  normalizeOphisQuoteAmounts,
  ophisSignedOrderAmounts,
} from "../src/venues/ophis.ts";

const APP = {
  appData: "{}",
  appDataHash:
    "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d",
};
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

describe("buildCowQuoteRequestBody", () => {
  test("sell: kind=sell + sellAmountBeforeFee only", () => {
    const body = buildCowQuoteRequestBody({
      sellToken: WETH,
      buyToken: USDC,
      side: "sell",
      amountIn: 10n ** 18n,
      ...APP,
    });
    expect(body.kind).toBe("sell");
    expect(body.sellAmountBeforeFee).toBe((10n ** 18n).toString());
    expect(body.buyAmountAfterFee).toBeUndefined();
    expect(body.sellToken).toBe(WETH.toLowerCase());
    expect(body.buyToken).toBe(USDC.toLowerCase());
  });

  test("buy: kind=buy + buyAmountAfterFee only (no sellAmountBeforeFee)", () => {
    const body = buildCowQuoteRequestBody({
      sellToken: WETH,
      buyToken: USDC,
      side: "buy",
      amountOut: 100_000_000n, // 100 USDC
      ...APP,
    });
    expect(body.kind).toBe("buy");
    expect(body.buyAmountAfterFee).toBe("100000000");
    expect(body.sellAmountBeforeFee).toBeUndefined();
  });

  test("rejects buy without amountOut", () => {
    expect(() =>
      buildCowQuoteRequestBody({
        sellToken: WETH,
        buyToken: USDC,
        side: "buy",
        ...APP,
      }),
    ).toThrow(/amountOut/);
  });

  test("rejects sell without amountIn", () => {
    expect(() =>
      buildCowQuoteRequestBody({
        sellToken: WETH,
        buyToken: USDC,
        side: "sell",
        ...APP,
      }),
    ).toThrow(/amountIn/);
  });
});

describe("normalizeCowQuoteAmounts", () => {
  test("folds fee into amountIn for both kinds", () => {
    const n = normalizeCowQuoteAmounts({
      side: "sell",
      sellAmount: "1000",
      buyAmount: "50",
      feeAmount: "7",
      partnerFeeBps: 0,
    });
    expect(n.amountIn).toBe("1007");
    expect(n.amountOut).toBe("50");
    expect(n.protocolFee?.raw).toBe("7");
    expect(n.protocolFee?.side).toBe("in");
  });
});

describe("cowSignedOrderAmounts", () => {
  test("sell: fee folded into sell; buy shrinks by slippage; feeAmount=0", () => {
    // 1% slip on buy 10_000 → 9900; sell 1000+fee 10 = 1010
    const s = cowSignedOrderAmounts({
      kind: "sell",
      sellAmount: "1000",
      buyAmount: "10000",
      feeAmount: "10",
      partnerFeeBps: 0,
      slippageBps: 100,
    });
    expect(s.kind).toBe("sell");
    expect(s.feeAmount).toBe("0");
    expect(s.sellAmount).toBe("1010");
    expect(s.buyAmount).toBe("9900");
  });

  test("buy: fee folded into sell; sell expands by slippage; buy stays exact; feeAmount=0", () => {
    // base sell 1000+10=1010; 1% slip → 1020 (1010 * 10100 / 10000)
    const s = cowSignedOrderAmounts({
      kind: "buy",
      sellAmount: "1000",
      buyAmount: "100000000", // exact USDC target
      feeAmount: "10",
      partnerFeeBps: 0,
      slippageBps: 100,
    });
    expect(s.kind).toBe("buy");
    expect(s.feeAmount).toBe("0");
    expect(s.buyAmount).toBe("100000000");
    expect(s.sellAmount).toBe(((1010n * 10_100n) / 10_000n).toString());
  });

  test("buy with 0 slip still folds fee and zeros feeAmount", () => {
    const s = cowSignedOrderAmounts({
      kind: "buy",
      sellAmount: "500",
      buyAmount: "1",
      feeAmount: "5",
      partnerFeeBps: 0,
      slippageBps: 0,
    });
    expect(s.sellAmount).toBe("505");
    expect(s.buyAmount).toBe("1");
    expect(s.feeAmount).toBe("0");
  });
});

describe("buildOphisQuoteRequestBody", () => {
  test("sell shape", () => {
    const body = buildOphisQuoteRequestBody({
      sellToken: WETH,
      buyToken: USDC,
      from: "0xdead",
      receiver: "0xdead",
      side: "sell",
      amountIn: 1n,
      ...APP,
    });
    expect(body.kind).toBe("sell");
    expect(body.sellAmountBeforeFee).toBe("1");
    expect(body.buyAmountAfterFee).toBeUndefined();
  });

  test("buy shape", () => {
    const body = buildOphisQuoteRequestBody({
      sellToken: WETH,
      buyToken: USDC,
      from: "0xdead",
      receiver: "0xdead",
      side: "buy",
      amountOut: 42n,
      ...APP,
    });
    expect(body.kind).toBe("buy");
    expect(body.buyAmountAfterFee).toBe("42");
    expect(body.sellAmountBeforeFee).toBeUndefined();
  });
});

describe("normalizeOphisQuoteAmounts", () => {
  test("sell: nets volume fee from amountOut; amountIn = sell+network fee", () => {
    // 5 bps of 10_000 = 5 → netOut 9995; in = 1000+0
    const n = normalizeOphisQuoteAmounts({
      side: "sell",
      sellAmount: "1000",
      buyAmount: "10000",
      feeAmount: "0",
      volumeBps: 5,
    });
    expect(n.amountIn).toBe("1000");
    expect(n.amountOut).toBe("9995");
    expect(n.protocolFee?.side).toBe("out");
    expect(n.protocolFee?.raw).toBe("5");
  });

  test("buy: grows amountIn by volume bps; amountOut stays exact", () => {
    // baseIn 1000; +5 bps → 1000 * 10005 / 10000 = 1000
    // use larger: 1e18 + 5 bps
    const base = 10n ** 18n;
    const n = normalizeOphisQuoteAmounts({
      side: "buy",
      sellAmount: base.toString(),
      buyAmount: "100000000",
      feeAmount: "0",
      volumeBps: 5,
    });
    expect(n.amountOut).toBe("100000000");
    expect(n.amountIn).toBe(((base * 10_005n) / 10_000n).toString());
    expect(n.protocolFee?.side).toBe("in");
  });
});

describe("ophisSignedOrderAmounts", () => {
  test("sell: CIP-75 then slippage on buy; fee fold on sell; feeAmount=0", () => {
    // gross buy 10_000, vol 5 → 9995; slip 100 bps → 9995*9900/10000
    const s = ophisSignedOrderAmounts({
      kind: "sell",
      sellAmount: "1000",
      buyAmount: "10000",
      feeAmount: "10",
      volumeBps: 5,
      slippageBps: 100,
    });
    expect(s.kind).toBe("sell");
    expect(s.feeAmount).toBe("0");
    expect(s.sellAmount).toBe("1010");
    const net = (10_000n * 9995n) / 10_000n;
    const minBuy = (net * 9900n) / 10_000n;
    expect(s.buyAmount).toBe(minBuy.toString());
  });

  test("buy: CIP-75 + slippage on max sell; buy exact; feeAmount=0", () => {
    // totalSell 1010; *10005/10000 partner; *10100/10000 slip
    const s = ophisSignedOrderAmounts({
      kind: "buy",
      sellAmount: "1000",
      buyAmount: "100000000",
      feeAmount: "10",
      volumeBps: 5,
      slippageBps: 100,
    });
    expect(s.kind).toBe("buy");
    expect(s.feeAmount).toBe("0");
    expect(s.buyAmount).toBe("100000000");
    const withPartner = (1010n * 10_005n) / 10_000n;
    const maxSell = (withPartner * 10_100n) / 10_000n;
    expect(s.sellAmount).toBe(maxSell.toString());
  });
});

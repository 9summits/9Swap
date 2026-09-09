import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  buildCowAppData,
  cowPartnerFeeBpsFromAppData,
  cowSignedOrderAmounts,
  normalizeCowQuoteAmounts,
} from "../src/venues/cow.ts";
import { resetReferralConfigCache, setNoFeeMode } from "../src/referral.ts";

const ENV_KEYS = [
  "REFERRAL_ADDRESS",
  "REFERRAL_NAME",
  "REFERRAL_FEE_BPS",
  "COW_REFERRAL_CODE",
  "ODOS_REFERRAL_CODE",
  "OPHIS_REFERRAL_CODE",
] as const;

const RECIPIENT_LOWER = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const RECIPIENT_EIP55 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const EMPTY_APP_DATA_HASH =
  "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d";

const saved = new Map<string, string | undefined>();

function configure(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  resetReferralConfigCache();
}

function keccakHex(s: string): string {
  const bytes = keccak_256(new TextEncoder().encode(s));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

beforeEach(() => {
  saved.clear();
  for (const k of ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  setNoFeeMode(false);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setNoFeeMode(false);
});

describe("buildCowAppData", () => {
  test("no referral env: canonical empty doc, no fee", () => {
    resetReferralConfigCache();
    const a = buildCowAppData();
    expect(a.appData).toBe("{}");
    expect(a.appDataHash).toBe(EMPTY_APP_DATA_HASH);
    expect(a.partnerFeeBps).toBe(0);
  });

  test("code only: referrer, no partnerFee", () => {
    configure({ COW_REFERRAL_CODE: "TESTCODE" });
    const a = buildCowAppData();
    expect(a.appData).toBe(
      '{"version":"1.15.0","appCode":"swap-selfhost","metadata":{"referrer":{"code":"TESTCODE"}}}',
    );
    expect(a.partnerFeeBps).toBe(0);
  });

  test("fee only: partnerFee with the EIP-55 recipient, no referrer", () => {
    configure({ REFERRAL_ADDRESS: RECIPIENT_LOWER, REFERRAL_FEE_BPS: "50" });
    const a = buildCowAppData();
    expect(a.appData).toBe(
      `{"version":"1.15.0","appCode":"swap-selfhost","metadata":{"partnerFee":{"volumeBps":50,"recipient":"${RECIPIENT_EIP55}"}}}`,
    );
    expect(a.appData).not.toContain("referrer");
    expect(a.partnerFeeBps).toBe(50);
  });

  test("code + fee: referrer serialized before partnerFee", () => {
    configure({
      COW_REFERRAL_CODE: "TESTCODE",
      REFERRAL_ADDRESS: RECIPIENT_LOWER,
      REFERRAL_FEE_BPS: "50",
    });
    const a = buildCowAppData();
    expect(a.appData).toBe(
      `{"version":"1.15.0","appCode":"swap-selfhost","metadata":{"referrer":{"code":"TESTCODE"},"partnerFee":{"volumeBps":50,"recipient":"${RECIPIENT_EIP55}"}}}`,
    );
    expect(a.partnerFeeBps).toBe(50);
  });

  test("--nofee drops partnerFee, keeps the free referrer code", () => {
    configure({
      COW_REFERRAL_CODE: "TESTCODE",
      REFERRAL_ADDRESS: RECIPIENT_LOWER,
      REFERRAL_FEE_BPS: "50",
    });
    setNoFeeMode(true);
    const a = buildCowAppData();
    expect(a.appData).toBe(
      '{"version":"1.15.0","appCode":"swap-selfhost","metadata":{"referrer":{"code":"TESTCODE"}}}',
    );
    expect(a.partnerFeeBps).toBe(0);
  });

  test("address without REFERRAL_FEE_BPS charges nothing", () => {
    configure({ REFERRAL_ADDRESS: RECIPIENT_LOWER });
    const a = buildCowAppData();
    expect(a.appData).toBe("{}");
    expect(a.partnerFeeBps).toBe(0);
  });

  test("clamps to CoW's 100 bps protocol ceiling", () => {
    configure({ REFERRAL_ADDRESS: RECIPIENT_LOWER, REFERRAL_FEE_BPS: "500" });
    const a = buildCowAppData();
    expect(a.appData).toBe(
      `{"version":"1.15.0","appCode":"swap-selfhost","metadata":{"partnerFee":{"volumeBps":100,"recipient":"${RECIPIENT_EIP55}"}}}`,
    );
    expect(a.partnerFeeBps).toBe(100);
  });

  test("appDataHash is keccak256 of the exact serialized string", () => {
    const configs = [
      {},
      { COW_REFERRAL_CODE: "TESTCODE" },
      { REFERRAL_ADDRESS: RECIPIENT_LOWER, REFERRAL_FEE_BPS: "50" },
      {
        COW_REFERRAL_CODE: "TESTCODE",
        REFERRAL_ADDRESS: RECIPIENT_LOWER,
        REFERRAL_FEE_BPS: "50",
      },
    ];
    for (const env of configs) {
      for (const k of ENV_KEYS) delete process.env[k];
      configure(env);
      const a = buildCowAppData();
      expect(a.appDataHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(a.appDataHash).toBe(keccakHex(a.appData));
    }
  });
});

describe("cowPartnerFeeBpsFromAppData", () => {
  test("round-trips every document buildCowAppData emits", () => {
    const cases: Array<[Record<string, string>, number]> = [
      [{}, 0],
      [{ COW_REFERRAL_CODE: "TESTCODE" }, 0],
      [{ REFERRAL_ADDRESS: RECIPIENT_LOWER, REFERRAL_FEE_BPS: "50" }, 50],
      [{ REFERRAL_ADDRESS: RECIPIENT_LOWER, REFERRAL_FEE_BPS: "500" }, 100],
      [
        {
          COW_REFERRAL_CODE: "TESTCODE",
          REFERRAL_ADDRESS: RECIPIENT_LOWER,
          REFERRAL_FEE_BPS: "50",
        },
        50,
      ],
    ];
    for (const [env, expected] of cases) {
      for (const k of ENV_KEYS) delete process.env[k];
      configure(env);
      const a = buildCowAppData();
      expect(cowPartnerFeeBpsFromAppData(a.appData)).toBe(a.partnerFeeBps);
      expect(cowPartnerFeeBpsFromAppData(a.appData)).toBe(expected);
    }
  });

  test("empty doc has no fee", () => {
    expect(cowPartnerFeeBpsFromAppData("{}")).toBe(0);
  });

  test("array form: first volume entry wins", () => {
    const doc = `{"metadata":{"partnerFee":[{"volumeBps":30,"recipient":"${RECIPIENT_EIP55}"}]}}`;
    expect(cowPartnerFeeBpsFromAppData(doc)).toBe(30);
  });

  test("throws on invalid JSON", () => {
    expect(() => cowPartnerFeeBpsFromAppData("{nope")).toThrow(/not valid JSON/);
  });

  test("throws on an unrecognized partnerFee shape", () => {
    expect(() =>
      cowPartnerFeeBpsFromAppData('{"metadata":{"partnerFee":{"nope":1}}}'),
    ).toThrow(/unrecognized metadata.partnerFee/);
  });

  test("accepts exactly the 100 bps ceiling", () => {
    const doc = `{"metadata":{"partnerFee":{"volumeBps":100,"recipient":"${RECIPIENT_EIP55}"}}}`;
    expect(cowPartnerFeeBpsFromAppData(doc)).toBe(100);
  });

  test("object form: throws above the 100 bps ceiling", () => {
    const doc = `{"metadata":{"partnerFee":{"volumeBps":101,"recipient":"${RECIPIENT_EIP55}"}}}`;
    expect(() => cowPartnerFeeBpsFromAppData(doc)).toThrow(
      /volumeBps=101, above the 100 bps ceiling/,
    );
  });

  test("array form: throws above the 100 bps ceiling", () => {
    const doc = `{"metadata":{"partnerFee":[{"volumeBps":10000,"recipient":"${RECIPIENT_EIP55}"}]}}`;
    expect(() => cowPartnerFeeBpsFromAppData(doc)).toThrow(
      /volumeBps=10000, above the 100 bps ceiling/,
    );
  });
});

// Envelope fixtures. SELL gross buy = 10000 + 10000*10/1000 = 10100, so a
// 50 bps partner fee is 10100*50/10000 = 50 (floored from 50.5).
const SELL = { sellAmount: "1000", buyAmount: "10000", feeAmount: "10" };
// BUY partner fee base is the raw sellAmount: 1000000*50/10000 = 5000.
const BUY = {
  sellAmount: "1000000",
  buyAmount: "100000000",
  feeAmount: "1000",
};

describe("normalizeCowQuoteAmounts partner fee netting", () => {
  test("sell without a partner fee is unchanged", () => {
    const n = normalizeCowQuoteAmounts({ side: "sell", ...SELL, partnerFeeBps: 0 });
    expect(n.amountIn).toBe("1010");
    expect(n.amountOut).toBe("10000");
    expect(n.protocolFee?.raw).toBe("10");
    expect(n.protocolFee?.side).toBe("in");
  });

  test("sell nets the fee off amountOut and flips the fee side to out", () => {
    const n = normalizeCowQuoteAmounts({ side: "sell", ...SELL, partnerFeeBps: 50 });
    expect(n.amountIn).toBe("1010");
    expect(n.amountOut).toBe("9950");
    expect(n.protocolFee?.raw).toBe("50");
    expect(n.protocolFee?.side).toBe("out");
    expect(n.protocolFee?.sharePct).toBe(0.5);
  });

  test("buy grows amountIn by exactly sellAmount * bps / 10000", () => {
    const free = normalizeCowQuoteAmounts({ side: "buy", ...BUY, partnerFeeBps: 0 });
    const paid = normalizeCowQuoteAmounts({ side: "buy", ...BUY, partnerFeeBps: 50 });
    expect(free.amountIn).toBe("1001000");
    expect(paid.amountIn).toBe("1006000");
    expect(BigInt(paid.amountIn) - BigInt(free.amountIn)).toBe(5000n);
    expect(paid.amountOut).toBe("100000000");
    expect(paid.protocolFee?.raw).toBe("6000");
    expect(paid.protocolFee?.side).toBe("in");
  });
});

describe("cowSignedOrderAmounts agrees with the displayed amounts", () => {
  test("sell: signed buyAmount at 0 slippage equals the netted amountOut", () => {
    const n = normalizeCowQuoteAmounts({ side: "sell", ...SELL, partnerFeeBps: 50 });
    const s = cowSignedOrderAmounts({
      kind: "sell",
      ...SELL,
      partnerFeeBps: 50,
      slippageBps: 0,
    });
    expect(s.buyAmount).toBe(n.amountOut);
    expect(s.buyAmount).toBe("9950");
    expect(s.sellAmount).toBe(n.amountIn);
    expect(s.feeAmount).toBe("0");
  });

  test("buy: signed sellAmount at 0 slippage equals the grossed amountIn", () => {
    const n = normalizeCowQuoteAmounts({ side: "buy", ...BUY, partnerFeeBps: 50 });
    const s = cowSignedOrderAmounts({
      kind: "buy",
      ...BUY,
      partnerFeeBps: 50,
      slippageBps: 0,
    });
    expect(s.sellAmount).toBe(n.amountIn);
    expect(s.sellAmount).toBe("1006000");
    expect(s.buyAmount).toBe("100000000");
    expect(s.feeAmount).toBe("0");
  });

  // Longhand, fee before slippage. sell: (10000-50)*9990/10000 = 9940, and at
  // 1000 bps (10000-50)*9000/10000 = 8955 — the transposed order would give
  // 8950. buy: (1000000+1000+5000)*10010/10000 = 1007006, transposed 1007001.
  test("sell: the partner fee is deducted before slippage is applied", () => {
    const s = cowSignedOrderAmounts({
      kind: "sell",
      ...SELL,
      partnerFeeBps: 50,
      slippageBps: 10,
    });
    expect(s.sellAmount).toBe("1010");
    expect(s.buyAmount).toBe("9940");

    const wide = cowSignedOrderAmounts({
      kind: "sell",
      ...SELL,
      partnerFeeBps: 50,
      slippageBps: 1000,
    });
    expect(wide.buyAmount).toBe("8955");
  });

  test("buy: the partner fee is added before slippage is applied", () => {
    const s = cowSignedOrderAmounts({
      kind: "buy",
      ...BUY,
      partnerFeeBps: 50,
      slippageBps: 10,
    });
    expect(s.sellAmount).toBe("1007006");
    expect(s.buyAmount).toBe("100000000");
  });

  test("partnerFeeBps 0 leaves the signed amounts untouched", () => {
    const s = cowSignedOrderAmounts({
      kind: "sell",
      ...SELL,
      partnerFeeBps: 0,
      slippageBps: 100,
    });
    expect(s.sellAmount).toBe("1010");
    expect(s.buyAmount).toBe("9900");
  });
});

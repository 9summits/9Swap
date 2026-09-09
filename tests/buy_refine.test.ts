import { describe, expect, test } from "bun:test";
import { resolveChain } from "../src/chains.ts";
import {
  minAmountOut,
  sellSlippageBpsForMinOutFloor,
} from "../src/slippage.ts";
import { GROSS, sortRoutesBySide } from "../shared/rank.ts";
import { pickBest, build } from "../src/venues/index.ts";
import type { NormalizedQuote, Venue } from "../src/venues/types.ts";

// Exact-out sell refine (network-free):
//   (a) sellSlippageBpsForMinOutFloor keeps minOut ≥ receive target
//   (b) ranking prefers surplus out on equal pay
//   (c) pickBest buy secondary key
//   (d) build() rejects buyRefine when amountOut < target (no silent under-delivery)
//   (e) build() rewrites buyRefine → side=sell with capped slippage (via mock adapter
//       is avoided — we assert the pre-adapter guard + slippage helper instead)

const CHAIN = resolveChain("eth");
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const TARGET = 158_000000n;
const SEED = 11_340000000000000000n;

function mkQuote(
  venue: Venue,
  amountIn: string,
  amountOut: string,
  extra?: Partial<NormalizedQuote>,
): NormalizedQuote {
  return {
    venue,
    amountIn,
    amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: null,
    hops: [],
    tokenHints: new Map(),
    raw: null,
    ...extra,
  };
}

describe("sellSlippageBpsForMinOutFloor", () => {
  test("caps slippage so minOut stays ≥ floor", () => {
    const quoted = 160_000000n;
    const floor = 158_000000n;
    expect(sellSlippageBpsForMinOutFloor(quoted, floor, 50)).toBe(50);
    const capped = sellSlippageBpsForMinOutFloor(quoted, floor, 200);
    expect(capped).toBeLessThan(200);
    expect(minAmountOut(quoted, capped)).toBeGreaterThanOrEqual(floor);
  });

  test("quotedOut == floor → 0 bps (minOut = target)", () => {
    expect(sellSlippageBpsForMinOutFloor(158n, 158n, 50)).toBe(0);
    expect(minAmountOut(158n, 0)).toBe(158n);
  });

  test("quotedOut < floor → 0 (route should have been filtered)", () => {
    expect(sellSlippageBpsForMinOutFloor(100n, 158n, 50)).toBe(0);
  });

  test("buy vs sell-flip parity: seed pay + surplus out keeps minOut ≥ target", () => {
    // Repro shape: buy suggested ~11.34 for 158; sell at same pay yields 160.
    const quotedOut = 160_000000n;
    const target = 158_000000n;
    const userSlip = 50;
    const bps = sellSlippageBpsForMinOutFloor(quotedOut, target, userSlip);
    expect(minAmountOut(quotedOut, bps)).toBeGreaterThanOrEqual(target);
    // Effective rate of refine ≥ exact buy target at same pay.
    expect(quotedOut).toBeGreaterThanOrEqual(target);
    void SEED;
  });
});

describe("buy ranking: min amountIn, then max amountOut on ties", () => {
  test("sortRoutesBySide buy prefers surplus out at equal pay", () => {
    const routes = [
      { venue: "velora", amountIn: "1134", amountOut: "158000000", execution: { kind: "async" as const } },
      { venue: "kyber", amountIn: "1134", amountOut: "160000000", execution: { kind: "async" as const } },
      { venue: "matcha", amountIn: "1200", amountOut: "158000000", execution: { kind: "async" as const } },
    ];
    const ranked = sortRoutesBySide(routes, "buy", GROSS);
    expect(ranked.map((r) => r.venue)).toEqual(["kyber", "velora", "matcha"]);
  });

  test("pickBest buy: equal amountIn → higher amountOut wins", () => {
    const results = [
      { venue: "velora" as const, quote: mkQuote("velora", "100", "1000") },
      { venue: "kyber" as const, quote: mkQuote("kyber", "100", "1100") },
      { venue: "matcha" as const, quote: mkQuote("matcha", "99", "1000") },
    ];
    const { best } = pickBest(results, "buy", GROSS);
    expect(best?.venue).toBe("matcha"); // lower pay wins first
    const tied = [
      { venue: "velora" as const, quote: mkQuote("velora", "100", "1000") },
      { venue: "kyber" as const, quote: mkQuote("kyber", "100", "1100") },
    ];
    expect(pickBest(tied, "buy", GROSS).best?.venue).toBe("kyber");
  });
});

describe("build buyRefine safety", () => {
  test("rejects buyRefine when amountOut < target (no silent under-delivery)", async () => {
    const bad = mkQuote("kyber", SEED.toString(), (TARGET - 1n).toString(), {
      buyRefine: {
        targetAmountOut: TARGET.toString(),
        seedAmountIn: SEED.toString(),
      },
    });
    await expect(
      build("kyber", {
        chain: CHAIN,
        tokenIn: WETH,
        tokenOut: USDC,
        tokenInDecimals: 18,
        tokenOutDecimals: 6,
        amountIn: SEED,
        side: "buy",
        sender: "0x1111111111111111111111111111111111111111",
        slippageBps: 50,
        quote: bad,
      }),
    ).rejects.toThrow(/below target/i);
  });

  test("sell-refine slippage floor is applied before adapter (unit of buildParams)", () => {
    // Mirror buildParamsForQuote math without calling the network adapter:
    // quoted 160, target 158, user slip 200 → capped so minOut ≥ 158.
    const quotedOut = 160_000000n;
    const target = TARGET;
    const slip = sellSlippageBpsForMinOutFloor(quotedOut, target, 200);
    const minOut = minAmountOut(quotedOut, slip);
    expect(minOut).toBeGreaterThanOrEqual(target);
    // Uncapped 200 bps would under-deliver:
    expect(minAmountOut(quotedOut, 200)).toBeLessThan(target);
  });
});

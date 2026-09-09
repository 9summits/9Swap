import { describe, expect, test } from "bun:test";
import {
  GROSS,
  compareBySide,
  effectiveRank,
  netUsdOf,
  rankAmount,
  rankModeFromFetched,
  rankModeFromPrices,
  rankRoutesBySide,
  sortRoutesBySide,
  toRankQuote,
  type Execution,
  type RankQuote,
} from "../shared/rank.ts";
import { pickBest, type VenueResult } from "../src/venues/index.ts";
import type { NormalizedQuote, Venue } from "../src/venues/types.ts";

const ONE = 10n ** 18n;
const COW_OUT = ONE.toString();
const KYBER_OUT = (ONE + ONE / 100n).toString();
const IN = ONE.toString();
const GAS_UNITS = 250_000;
const GAS_PRICE_WEI = (20n * 10n ** 9n).toString();

const ASYNC: Execution = { kind: "async" };
const KYBER_SYNC: Execution = {
  kind: "sync",
  gasUnits: GAS_UNITS,
  gasPriceWei: GAS_PRICE_WEI,
};
const UNKNOWN_SYNC: Execution = {
  kind: "sync",
  gasUnits: null,
  gasPriceWei: null,
};

const NET_18 = rankModeFromPrices({
  nativeUsd: 3000,
  tokenUsd: 1,
  tokenDecimals: 18,
});

function rq(
  amountIn: string,
  amountOut: string,
  execution: Execution,
): RankQuote {
  return { amountIn, amountOut, execution };
}

function nq(
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
    gasUnits: extra?.gasUnits ?? null,
    gasPriceWei: extra?.gasPriceWei ?? null,
    gasUsd: extra?.gasUsd ?? null,
    router: null,
    hops: [],
    tokenHints: new Map(),
    raw: null,
    ...extra,
  };
}

function result(
  venue: Venue,
  amountIn: string,
  amountOut: string,
  extra?: Partial<NormalizedQuote>,
): VenueResult {
  return { venue, quote: nq(venue, amountIn, amountOut, extra) };
}

const cowSell = rq(IN, COW_OUT, ASYNC);
const kyberSell = rq(IN, KYBER_OUT, KYBER_SYNC);

describe("B fixture: sell, tokenOut $1, native $3000, 18 decimals", () => {
  test("net: cow (async 1.00) beats kyber (1.01 minus 0.005 ETH gas)", () => {
    expect(NET_18.mode).toBe("net");
    const ranked = sortRoutesBySide(
      [
        { venue: "kyber", ...kyberSell },
        { venue: "cow", ...cowSell },
      ],
      "sell",
      NET_18,
    );
    expect(ranked.map((r) => r.venue)).toEqual(["cow", "kyber"]);
    expect(rankAmount(cowSell, "sell", NET_18)).toBe(COW_OUT);
    const kyberNet = BigInt(rankAmount(kyberSell, "sell", NET_18));
    expect(kyberNet).toBe(BigInt(KYBER_OUT) - 15n * ONE);
    expect(kyberNet < 0n).toBe(true);
  });

  test("GROSS: kyber wins", () => {
    const ranked = sortRoutesBySide(
      [
        { venue: "cow", ...cowSell },
        { venue: "kyber", ...kyberSell },
      ],
      "sell",
      GROSS,
    );
    expect(ranked.map((r) => r.venue)).toEqual(["kyber", "cow"]);
  });

  test("netUsdOf is display-only IEEE (not the sort key)", () => {
    const cowUsd = netUsdOf(cowSell, "sell", NET_18);
    const kyberUsd = netUsdOf(kyberSell, "sell", NET_18);
    expect(cowUsd).toBeCloseTo(1, 6);
    expect(kyberUsd).toBeCloseTo(1.01 - 15, 6);
    expect(netUsdOf(cowSell, "sell", GROSS)).toBeNull();
  });
});

describe("buy side (gas added to pay)", () => {
  const cowBuy = rq("1010000000000000000", ONE.toString(), ASYNC);
  const kyberBuy = rq("1000000000000000000", ONE.toString(), KYBER_SYNC);

  test("GROSS: kyber pays less", () => {
    const ranked = sortRoutesBySide(
      [
        { venue: "cow", ...cowBuy },
        { venue: "kyber", ...kyberBuy },
      ],
      "buy",
      GROSS,
    );
    expect(ranked[0]!.venue).toBe("kyber");
  });

  test("net: cow wins because kyber pay plus haircut is larger", () => {
    const ranked = sortRoutesBySide(
      [
        { venue: "cow", ...cowBuy },
        { venue: "kyber", ...kyberBuy },
      ],
      "buy",
      NET_18,
    );
    expect(ranked[0]!.venue).toBe("cow");
    expect(BigInt(rankAmount(kyberBuy, "buy", NET_18))).toBe(
      ONE + 15n * ONE,
    );
  });
});

describe("rankModeFromFetched", () => {
  const fetchedOk = {
    side: "sell" as const,
    nativeUsd: 3000,
    tokenInUsd: 2000,
    tokenOutUsd: 1,
    tokenInDecimals: 18,
    tokenOutDecimals: 18,
  };

  test("missing CG price → GROSS", () => {
    expect(rankModeFromFetched({ ...fetchedOk, nativeUsd: null }).mode).toBe(
      "gross",
    );
    expect(rankModeFromFetched({ ...fetchedOk, tokenOutUsd: null }).mode).toBe(
      "gross",
    );
    expect(rankModeFromFetched({ ...fetchedOk, tokenOutUsd: 0 }).mode).toBe(
      "gross",
    );
    expect(rankModeFromFetched({ ...fetchedOk, nativeUsd: NaN }).mode).toBe(
      "gross",
    );
  });

  test("invalid decimals → GROSS", () => {
    expect(
      rankModeFromFetched({ ...fetchedOk, tokenOutDecimals: 18.5 }).mode,
    ).toBe("gross");
    expect(
      rankModeFromFetched({ ...fetchedOk, tokenOutDecimals: -1 }).mode,
    ).toBe("gross");
    expect(
      rankModeFromFetched({ ...fetchedOk, tokenOutDecimals: 256 }).mode,
    ).toBe("gross");
    expect(rankModeFromPrices({ nativeUsd: 1, tokenUsd: 1, tokenDecimals: 18 }).mode).toBe(
      "net",
    );
  });

  test("buy uses tokenIn USD and decimals", () => {
    const buy = rankModeFromFetched({
      side: "buy",
      nativeUsd: 3000,
      tokenInUsd: 1,
      tokenOutUsd: null,
      tokenInDecimals: 18,
      tokenOutDecimals: 6,
    });
    expect(buy.mode).toBe("net");
    if (buy.mode === "net") expect(buy.tokenDecimals).toBe(18);
  });
});

describe("unknown gas under net", () => {
  test("sync missing gasUnits sinks and does not beat async as 0", () => {
    const unknown = rq(IN, KYBER_OUT, UNKNOWN_SYNC);
    expect(rankAmount(unknown, "sell", NET_18)).toBe("");
    const ranked = sortRoutesBySide(
      [
        { venue: "kyber", ...unknown },
        { venue: "cow", ...cowSell },
      ],
      "sell",
      NET_18,
    );
    expect(ranked[0]!.venue).toBe("cow");
    expect(compareBySide(rankAmount(unknown, "sell", NET_18), COW_OUT, "sell")).toBeGreaterThan(
      0,
    );
  });

  test("sync missing gasPriceWei also sinks", () => {
    const missingPrice = rq(IN, KYBER_OUT, {
      kind: "sync",
      gasUnits: GAS_UNITS,
      gasPriceWei: null,
    });
    expect(rankAmount(missingPrice, "sell", NET_18)).toBe("");
  });

  test("all-unknown + net → effectiveRank GROSS, still a winner", () => {
    const a = rq(IN, "10", UNKNOWN_SYNC);
    const b = rq(IN, "20", UNKNOWN_SYNC);
    const quotes = [a, b];
    expect(effectiveRank(quotes, NET_18)).toEqual(GROSS);
    const ranked = sortRoutesBySide(
      [
        { venue: "a", ...a },
        { venue: "b", ...b },
      ],
      "sell",
      NET_18,
    );
    expect(ranked[0]!.venue).toBe("b");
    const results: VenueResult[] = [
      result("kyber", IN, "10"),
      result("velora", IN, "20"),
    ];
    const { best } = pickBest(results, "sell", NET_18);
    expect(best?.venue).toBe("velora");
  });
});

describe("token decimals are not coerced to 18", () => {
  test("6-decimal token: 0.005 ETH at $3000 haircuts 15 whole tokens", () => {
    const net6 = rankModeFromPrices({
      nativeUsd: 3000,
      tokenUsd: 1,
      tokenDecimals: 6,
    });
    expect(net6.mode).toBe("net");
    const q = rq("1000000", "20000000", KYBER_SYNC);
    expect(rankAmount(q, "sell", net6)).toBe("5000000");
  });
});

describe("sell haircut that goes non-positive sinks", () => {
  test("negative net string is not pickBest-eligible", () => {
    const results: VenueResult[] = [
      result("kyber", IN, KYBER_OUT, {
        gasUnits: GAS_UNITS,
        gasPriceWei: GAS_PRICE_WEI,
      }),
    ];
    expect(pickBest(results, "sell", NET_18).best).toBeNull();
    expect(pickBest(results, "sell", GROSS).best?.venue).toBe("kyber");
  });
});

describe("pickBest agrees with sortRoutesBySide[0]", () => {
  test("net sell fixture", () => {
    const results: VenueResult[] = [
      result("kyber", IN, KYBER_OUT, {
        gasUnits: GAS_UNITS,
        gasPriceWei: GAS_PRICE_WEI,
      }),
      result("cow", IN, COW_OUT),
    ];
    const quotes = results.flatMap((r) =>
      "quote" in r
        ? [
            {
              venue: r.venue,
              ...toRankQuote(r.quote, r.venue === "cow"),
            },
          ]
        : [],
    );
    const sorted = sortRoutesBySide(quotes, "sell", NET_18);
    const { best } = pickBest(results, "sell", NET_18);
    expect(best?.venue).toBe(sorted[0]!.venue);
    expect(best?.venue).toBe("cow");
  });

  test("rankRoutesBySide is the same order as sortRoutesBySide", () => {
    const routes = [
      { venue: "kyber", ...kyberSell },
      { venue: "cow", ...cowSell },
    ];
    expect(rankRoutesBySide(routes, "sell", NET_18).map((r) => r.venue)).toEqual(
      sortRoutesBySide(routes, "sell", NET_18).map((r) => r.venue),
    );
  });

  test("sort does not mutate", () => {
    const routes = [
      { venue: "a", ...cowSell },
      { venue: "b", ...kyberSell },
    ];
    const before = routes.map((r) => r.venue);
    sortRoutesBySide(routes, "sell", GROSS);
    expect(routes.map((r) => r.venue)).toEqual(before);
  });
});

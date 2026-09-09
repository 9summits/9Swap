import { test, expect } from "bun:test";
import {
  removeRawVenue,
  seedRawRoutes,
  shouldAutoRefresh,
  shouldKeepPrevious,
  upsertRawRoute,
} from "../web/src/dapp/useQuote.ts";
import type { QuoteResponse, RawRoute } from "../web/src/dapp/types.ts";

function raw(venue: string, amountOut: string): RawRoute {
  return {
    venue,
    amountIn: "1000",
    amountOut,
    gasUsd: 0.1,
    priceImpactPct: null,
    kind: "sync",
    gasUnits: null,
    gasPriceWei: null,
    amountInUsd: 2000,
    amountOutUsd: 1990,
  };
}

const EXP = 1_000_000;

test("hidden + expired + timer → false", () => {
  expect(
    shouldAutoRefresh({
      visible: false,
      now: EXP + 1,
      expiresAt: EXP,
      pendingWhileHidden: false,
      firedForExpiresAt: null,
      source: "timer",
    }),
  ).toBe(false);
});

test("visible + expired + not yet fired → true", () => {
  expect(
    shouldAutoRefresh({
      visible: true,
      now: EXP,
      expiresAt: EXP,
      pendingWhileHidden: false,
      firedForExpiresAt: null,
      source: "timer",
    }),
  ).toBe(true);
});

test("visible + expired + already fired for that expiresAt → false", () => {
  expect(
    shouldAutoRefresh({
      visible: true,
      now: EXP + 5_000,
      expiresAt: EXP,
      pendingWhileHidden: false,
      firedForExpiresAt: EXP,
      source: "visible",
    }),
  ).toBe(false);
});

test("visible + not expired → false", () => {
  expect(
    shouldAutoRefresh({
      visible: true,
      now: EXP - 1,
      expiresAt: EXP,
      pendingWhileHidden: false,
      firedForExpiresAt: null,
      source: "timer",
    }),
  ).toBe(false);
});

test("hidden + visible-source → false", () => {
  expect(
    shouldAutoRefresh({
      visible: false,
      now: EXP + 1,
      expiresAt: EXP,
      pendingWhileHidden: true,
      firedForExpiresAt: null,
      source: "visible",
    }),
  ).toBe(false);
});

test("no expiresAt + visible + timer → true", () => {
  expect(
    shouldAutoRefresh({
      visible: true,
      now: 0,
      expiresAt: null,
      pendingWhileHidden: false,
      firedForExpiresAt: null,
      source: "timer",
    }),
  ).toBe(true);
});

test("no expiresAt + visible + visible-source + pending → true", () => {
  expect(
    shouldAutoRefresh({
      visible: true,
      now: 0,
      expiresAt: null,
      pendingWhileHidden: true,
      firedForExpiresAt: null,
      source: "visible",
    }),
  ).toBe(true);
});

test("no expiresAt + visible + visible-source + !pending → false", () => {
  expect(
    shouldAutoRefresh({
      visible: true,
      now: 0,
      expiresAt: null,
      pendingWhileHidden: false,
      firedForExpiresAt: null,
      source: "visible",
    }),
  ).toBe(false);
});

test("upsertRawRoute inserts then replaces by venue", () => {
  const routes: RawRoute[] = [];
  upsertRawRoute(routes, raw("kyber", "10"));
  upsertRawRoute(routes, raw("curve", "9"));
  upsertRawRoute(routes, raw("kyber", "11"));
  expect(routes.map((r) => [r.venue, r.amountOut])).toEqual([
    ["kyber", "11"],
    ["curve", "9"],
  ]);
});

test("removeRawVenue drops only that venue", () => {
  const routes = [raw("kyber", "10"), raw("openocean", "8"), raw("curve", "9")];
  removeRawVenue(routes, "openocean");
  expect(routes.map((r) => r.venue)).toEqual(["kyber", "curve"]);
  removeRawVenue(routes, "missing");
  expect(routes.map((r) => r.venue)).toEqual(["kyber", "curve"]);
});

test("shouldKeepPrevious: purge → false", () => {
  expect(
    shouldKeepPrevious({
      purge: true,
      reqKey: "a",
      lastKey: "a",
      hasQuote: true,
      lastRawLen: 2,
    }),
  ).toBe(false);
});

test("shouldKeepPrevious: same key + quote → true", () => {
  expect(
    shouldKeepPrevious({
      purge: false,
      reqKey: "a",
      lastKey: "a",
      hasQuote: true,
      lastRawLen: 0,
    }),
  ).toBe(true);
});

test("shouldKeepPrevious: key change → false", () => {
  expect(
    shouldKeepPrevious({
      purge: false,
      reqKey: "b",
      lastKey: "a",
      hasQuote: true,
      lastRawLen: 2,
    }),
  ).toBe(false);
});

test("shouldKeepPrevious: same key + lastRaw, no quote → true", () => {
  expect(
    shouldKeepPrevious({
      purge: false,
      reqKey: "a",
      lastKey: "a",
      hasQuote: false,
      lastRawLen: 1,
    }),
  ).toBe(true);
});

test("seedRawRoutes prefers lastRaw, else quote.routes", () => {
  const last = [raw("kyber", "10")];
  expect(seedRawRoutes(last, null).map((r) => r.venue)).toEqual(["kyber"]);
  const previous = {
    routes: [raw("curve", "9"), raw("velora", "8")],
  } as unknown as QuoteResponse;
  const fromQuote = seedRawRoutes(null, previous);
  expect(fromQuote.map((r) => r.venue)).toEqual(["curve", "velora"]);
  expect(fromQuote[0]?.amountInUsd).toBeNull();
  expect(seedRawRoutes(null, null)).toEqual([]);
});

test("keepPrevious seed + curve upsert + verror + done merge", () => {
  const lastRaw = [
    raw("kyber", "10"),
    raw("openocean", "8"),
    raw("curve", "9"),
    raw("matcha", "7"),
  ];
  const routes = lastRaw.map((r) => ({ ...r }));
  const settled = new Set<string>();
  const errs: { venue: string; reason: string }[] = [];

  upsertRawRoute(routes, raw("curve", "9.5"));
  settled.add("curve");
  expect(routes.map((r) => r.venue)).toEqual([
    "kyber",
    "openocean",
    "curve",
    "matcha",
  ]);
  expect(routes.find((r) => r.venue === "curve")?.amountOut).toBe("9.5");
  expect(routes.find((r) => r.venue === "kyber")?.amountOut).toBe("10");

  removeRawVenue(routes, "openocean");
  errs.push({ venue: "openocean", reason: "openocean: timeout after 15s" });
  settled.add("openocean");
  expect(routes.some((r) => r.venue === "openocean")).toBe(false);
  expect(routes.some((r) => r.venue === "kyber")).toBe(true);

  upsertRawRoute(routes, raw("kyber", "10.2"));
  settled.add("kyber");

  const next = routes.filter((r) => settled.has(r.venue));
  expect(next.map((r) => r.venue)).toEqual(["kyber", "curve"]);
  expect(next.find((r) => r.venue === "kyber")?.amountOut).toBe("10.2");
  expect(errs).toEqual([
    { venue: "openocean", reason: "openocean: timeout after 15s" },
  ]);
});

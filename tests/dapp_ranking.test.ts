import { test, expect } from "bun:test";
import {
  GROSS,
  rankRoutesBySide,
  type Execution,
} from "../shared/rank.ts";

const ASYNC: Execution = { kind: "async" };

type R = {
  venue: string;
  amountIn: string;
  amountOut: string;
  execution: Execution;
};

test("sell ranks by descending amountOut (most received first)", () => {
  const routes: R[] = [
    { venue: "a", amountIn: "1000", amountOut: "3000", execution: ASYNC },
    { venue: "b", amountIn: "1000", amountOut: "3100", execution: ASYNC },
    { venue: "c", amountIn: "1000", amountOut: "2950", execution: ASYNC },
  ];
  const ranked = rankRoutesBySide(routes, "sell", GROSS);
  expect(ranked.map((r) => r.venue)).toEqual(["b", "a", "c"]);
});

test("buy ranks by ascending amountIn (least paid first)", () => {
  const routes: R[] = [
    { venue: "a", amountIn: "1010", amountOut: "3000", execution: ASYNC },
    { venue: "b", amountIn: "990", amountOut: "3000", execution: ASYNC },
    { venue: "c", amountIn: "1005", amountOut: "3000", execution: ASYNC },
  ];
  const ranked = rankRoutesBySide(routes, "buy", GROSS);
  expect(ranked.map((r) => r.venue)).toEqual(["b", "c", "a"]);
});

test("buy ties on amountIn prefer higher amountOut (sell-refine surplus)", () => {
  const routes: R[] = [
    { venue: "native", amountIn: "100", amountOut: "158", execution: ASYNC },
    { venue: "refine", amountIn: "100", amountOut: "162", execution: ASYNC },
    { venue: "worse", amountIn: "110", amountOut: "200", execution: ASYNC },
  ];
  const ranked = rankRoutesBySide(routes, "buy", GROSS);
  expect(ranked.map((r) => r.venue)).toEqual(["refine", "native", "worse"]);
});

test("buy sinks non-positive / unparseable amountIn to the bottom", () => {
  const routes: R[] = [
    { venue: "zero", amountIn: "0", amountOut: "3000", execution: ASYNC },
    { venue: "good", amountIn: "990", amountOut: "3000", execution: ASYNC },
    { venue: "bad", amountIn: "not-a-number", amountOut: "3000", execution: ASYNC },
  ];
  const ranked = rankRoutesBySide(routes, "buy", GROSS);
  expect(ranked[0]!.venue).toBe("good");
  expect(ranked.slice(1).map((r) => r.venue).sort()).toEqual(["bad", "zero"]);
});

test("does not mutate the input array", () => {
  const routes: R[] = [
    { venue: "a", amountIn: "1", amountOut: "1", execution: ASYNC },
    { venue: "b", amountIn: "1", amountOut: "2", execution: ASYNC },
  ];
  const before = routes.map((r) => r.venue);
  rankRoutesBySide(routes, "sell", GROSS);
  expect(routes.map((r) => r.venue)).toEqual(before);
});

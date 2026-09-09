import { afterEach, expect, test } from "bun:test";
import {
  VENUE_TIMEOUT_MS,
  setVenueTimeoutMsForTests,
  venueFetch,
  withVenueTimeout,
} from "../src/venues/http.ts";
import { fetchQuote } from "../src/venues/index.ts";
import { CHAINS } from "../src/chains.ts";

const realFetch = globalThis.fetch;
const savedKey = process.env.OPENOCEAN_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  setVenueTimeoutMsForTests(VENUE_TIMEOUT_MS);
  if (savedKey === undefined) delete process.env.OPENOCEAN_API_KEY;
  else process.env.OPENOCEAN_API_KEY = savedKey;
});

test("venueFetch rejects a hanging fetch on the test timeout", async () => {
  setVenueTimeoutMsForTests(50);
  globalThis.fetch = ((_input, init) =>
    new Promise((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return;
      const fail = () => {
        const err = new Error("The operation was aborted");
        err.name = "TimeoutError";
        reject(err);
      };
      if (s.aborted) fail();
      else s.addEventListener("abort", fail, { once: true });
    })) as typeof fetch;
  const start = Date.now();
  let err: unknown;
  try {
    await venueFetch("https://example.invalid");
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  const name = (err as Error).name;
  expect(name === "TimeoutError" || name === "AbortError").toBe(true);
  expect(Date.now() - start).toBeLessThan(500);
});

test("withVenueTimeout rejects with a venue timeout message", async () => {
  setVenueTimeoutMsForTests(50);
  const start = Date.now();
  await expect(
    withVenueTimeout("openocean", () => new Promise(() => {})),
  ).rejects.toThrow(/openocean: timeout after /);
  expect(Date.now() - start).toBeLessThan(500);
});

test("fetchQuote times out a hanging openocean quote", async () => {
  setVenueTimeoutMsForTests(50);
  process.env.OPENOCEAN_API_KEY = "test-key";
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  const start = Date.now();
  await expect(
    fetchQuote({
      venue: "openocean",
      chain: CHAINS.eth,
      tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      tokenOut: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
      amountIn: 10n ** 18n,
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      slippageBps: 50,
    }),
  ).rejects.toThrow(/openocean: timeout after /);
  expect(Date.now() - start).toBeLessThan(1000);
});

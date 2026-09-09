import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveChain } from "../src/chains.ts";
import {
  getRpcUrl,
  resetPublicRpcFallback,
  RpcConfigError,
  setPublicRpcFallback,
  setRpcOverride,
  tryRpcUrl,
} from "../src/rpc.ts";

const ENV_KEYS = [
  "ALCHEMY_API_KEY",
  "RPC_URL_1",
  "ETH_RPC_URL",
  "RPC_URL_4663",
  "ROBINHOOD_RPC_URL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  setRpcOverride(null);
  resetPublicRpcFallback();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setRpcOverride(null);
  resetPublicRpcFallback();
});

test("fallback off, no env → tryRpcUrl is null and getRpcUrl throws RpcConfigError", () => {
  const eth = resolveChain("eth");
  expect(tryRpcUrl(eth)).toBeNull();
  expect(() => getRpcUrl(eth)).toThrow(RpcConfigError);
  expect(() => getRpcUrl(eth)).toThrow(/ALCHEMY_API_KEY/);
});

test("fallback on, no env → PublicNode ethereum URL", () => {
  setPublicRpcFallback(true);
  const eth = resolveChain("eth");
  expect(tryRpcUrl(eth)).toBe("https://ethereum-rpc.publicnode.com");
  expect(getRpcUrl(eth)).toBe("https://ethereum-rpc.publicnode.com");
});

test("fallback on, ALCHEMY_API_KEY set → Alchemy URL wins", () => {
  setPublicRpcFallback(true);
  process.env.ALCHEMY_API_KEY = "testkey";
  const eth = resolveChain("eth");
  expect(tryRpcUrl(eth)).toBe(
    "https://eth-mainnet.g.alchemy.com/v2/testkey",
  );
  expect(getRpcUrl(eth)).toBe(
    "https://eth-mainnet.g.alchemy.com/v2/testkey",
  );
});

test("fallback on, RPC_URL_1 set → override wins without Alchemy", () => {
  setPublicRpcFallback(true);
  process.env.RPC_URL_1 = "https://example.rpc";
  const eth = resolveChain("eth");
  expect(tryRpcUrl(eth)).toBe("https://example.rpc");
  expect(getRpcUrl(eth)).toBe("https://example.rpc");
});

test("fallback on, robinhood, no env → Robinhood public RPC", () => {
  setPublicRpcFallback(true);
  const robinhood = resolveChain("robinhood");
  expect(tryRpcUrl(robinhood)).toBe(
    "https://rpc.mainnet.chain.robinhood.com",
  );
  expect(getRpcUrl(robinhood)).toBe(
    "https://rpc.mainnet.chain.robinhood.com",
  );
});

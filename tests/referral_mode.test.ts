import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  getReferralConfig,
  resetReferralConfigCache,
  resetReferralMode,
  setReferralMode,
} from "../src/referral.ts";

let savedName: string | undefined;

beforeEach(() => {
  savedName = process.env.REFERRAL_NAME;
  delete process.env.REFERRAL_NAME;
  resetReferralMode();
  resetReferralConfigCache();
});

afterEach(() => {
  if (savedName === undefined) delete process.env.REFERRAL_NAME;
  else process.env.REFERRAL_NAME = savedName;
  resetReferralMode();
  resetReferralConfigCache();
});

test("no mode + unset env → name is the bare self-host default", () => {
  expect(getReferralConfig().name).toBe("swap-selfhost");
});

test("no mode + REFERRAL_NAME=swagg → name is swagg", () => {
  process.env.REFERRAL_NAME = "swagg";
  resetReferralConfigCache();
  expect(getReferralConfig().name).toBe("swagg");
});

test("setReferralMode(cli) + unset env → name is swap-selfhost-cli", () => {
  setReferralMode("cli");
  expect(getReferralConfig().name).toBe("swap-selfhost-cli");
});

test("setReferralMode(dapp) + unset env → name is swap-selfhost-dapp", () => {
  setReferralMode("dapp");
  expect(getReferralConfig().name).toBe("swap-selfhost-dapp");
});

test("setReferralMode(browser) + unset env → name is swap-selfhost-browser", () => {
  setReferralMode("browser");
  expect(getReferralConfig().name).toBe("swap-selfhost-browser");
});

test("setting the same mode twice does not double the suffix", () => {
  setReferralMode("dapp");
  expect(getReferralConfig().name).toBe("swap-selfhost-dapp");
  setReferralMode("dapp");
  expect(getReferralConfig().name).toBe("swap-selfhost-dapp");
});

test("setReferralMode(dapp) + REFERRAL_NAME=swagg → name is swagg-dapp", () => {
  process.env.REFERRAL_NAME = "swagg";
  setReferralMode("dapp");
  expect(getReferralConfig().name).toBe("swagg-dapp");
});

test("setReferralMode(browser) + REFERRAL_NAME=swagg → name is swagg-browser", () => {
  process.env.REFERRAL_NAME = "swagg";
  setReferralMode("browser");
  expect(getReferralConfig().name).toBe("swagg-browser");
});

test("resetReferralMode restores unsuffixed names", () => {
  process.env.REFERRAL_NAME = "swagg";
  setReferralMode("cli");
  expect(getReferralConfig().name).toBe("swagg-cli");
  resetReferralMode();
  expect(getReferralConfig().name).toBe("swagg");
});

test("resetReferralConfigCache drops a leaked mode", () => {
  process.env.REFERRAL_NAME = "swagg";
  setReferralMode("dapp");
  expect(getReferralConfig().name).toBe("swagg-dapp");
  resetReferralConfigCache();
  expect(getReferralConfig().name).toBe("swagg");
});

test("REFERRAL_NAME is the base the mode suffix is appended to", () => {
  process.env.REFERRAL_NAME = "swap";
  setReferralMode("browser");
  expect(getReferralConfig().name).toBe("swap-browser");
});

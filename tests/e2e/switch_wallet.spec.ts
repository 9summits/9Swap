import { test, expect } from "@playwright/test";
import {
  swapUrl,
  waitForDappReady,
  installMockWallet,
  ensureConnected,
} from "./helpers";

// Header account chip: local menu (copy / switch / disconnect) instead of
// RainbowKit's account modal. Switch wallet disconnects then reopens the
// connect picker. Success is seeing "Mock Wallet" in that picker.

test("header · switch wallet reopens the connect picker", async ({ page }) => {
  await installMockWallet(page);
  await page.goto(swapUrl());
  await waitForDappReady(page);
  await ensureConnected(page);

  await page.getByRole("button", { name: /Connected wallet/i }).click();
  await expect(page.getByRole("menuitem", { name: "Copy address" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Switch wallet" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Disconnect" })).toBeVisible();

  await page.getByRole("menuitem", { name: "Switch wallet" }).click();
  await expect(page.getByRole("button", { name: /Mock Wallet/i }).first()).toBeVisible({
    timeout: 15_000,
  });
});

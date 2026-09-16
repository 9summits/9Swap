import { chromium } from "@playwright/test";

const APP_URL = process.env.APP_URL ?? "https://swap.9summits.io";
const SAFE = process.env.SAFE ?? "eth:0xC868BFb240Ed207449Afe71D2ecC781D5E10C85C";
const VENUE = process.env.VENUE ?? "KyberSwap";
const OUT = process.env.OUT ?? ".";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const app = `${APP_URL.replace(/\/$/, "")}/?chain=eth&in=${USDC}&out=${USDT}&amount=1`;
const safeUrl = `https://app.safe.global/apps/open?safe=${SAFE}&appUrl=${encodeURIComponent(app)}`;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("console", (m) => {
  if (/SendTx|wallet_|capabilit/i.test(m.text())) console.log(`[iframe console:${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`));

await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
const save = page.getByRole("button", { name: "Save settings" });
if (await save.isVisible({ timeout: 8000 }).catch(() => false)) await save.click();

// The warning dialog re-renders once after hydration, so one click is not enough.
const cont = page.getByRole("button", { name: "Continue" });
await cont.waitFor({ timeout: 30_000 });
let t0 = Date.now();
for (let i = 0; i < 4 && (await cont.isVisible().catch(() => false)); i++) {
  await cont.click();
  t0 = Date.now();
  await page.waitForTimeout(2500);
}

const frame = page.frameLocator('iframe[src*="' + new URL(APP_URL).host + '"]');
const safeShort = SAFE.split(":")[1]!.slice(0, 6);
await frame.getByText(new RegExp(safeShort)).first().waitFor({ timeout: 30_000 });
console.log(`auto-connected to the Safe ${Date.now() - t0} ms after Continue`);
console.log("chain chip:", await frame.locator("[data-chain-name]").first().innerText());

const swap = frame.getByRole("button", { name: "Swap", exact: true });
await swap.waitFor({ timeout: 60_000 });
await frame.getByText(VENUE, { exact: true }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/safe-probe-before-swap.png` });
await swap.click();

const modal = page.locator('[role="dialog"], [role="presentation"]').filter({ hasText: /Confirm transaction/i }).first();
await modal.waitFor({ timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/safe-probe-modal.png` });
const text = await modal.innerText();
const actions = text.match(/All actions[\s\S]*?Transaction details/)?.[0] ?? "";
console.log("Safe modal actions:", actions.replace(/\s+/g, " ").trim());
console.log("multiSend:", /multiSend/.test(text));
console.log("dApp status:", await frame.locator("[data-dapp-body]").innerText().then((s) => s.split("\n").filter((l) => /batch|queued|wallet/i.test(l)).join(" | ")));
await browser.close();

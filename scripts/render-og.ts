// Render scripts/og-card.html → web/public/og.png at 1200×630.
// Usage: bun run scripts/render-og.ts
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const html = join(root, "scripts/og-card.html");
const out = join(root, "web/public/og.png");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
});
await page.goto(`file://${html}`, { waitUntil: "networkidle" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.log("wrote", out);

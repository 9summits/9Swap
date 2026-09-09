import { defineConfig, devices } from "@playwright/test";

// E2E config for the interactive dApp (`swap` with no args → src/serve.ts).
//
// The webServer below launches the REAL CLI server, which serves the embedded
// production bundle (web/dist/index.html) AND the /api/* endpoints — so these
// tests exercise the exact artifact that ships, not a vite dev build. If you
// change anything under web/src, rebuild first: `cd web && bun run build`.
//
// We drive the system-installed Google Chrome (channel: "chrome") to avoid
// downloading Playwright's bundled chromium. Run with:  bun run test:e2e
//
// Requires a populated .env (ALCHEMY_API_KEY + the per-venue keys, incl.
// ZEROEX_API_KEY for matcha).

const PORT = 5151;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Venue quotes hit live aggregator APIs; curve-js does a ~12s cold on-chain
  // init on its first quote. Give each test room without being absurd.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // One worker: a single shared server + we don't want to hammer venue APIs in
  // parallel (rate limits) and the runs stay deterministic / readable.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Chrome on a headless/CI-ish Linux box often needs the sandbox dropped.
    launchOptions: { args: ["--no-sandbox"] },
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    command: "bun run src/index.ts",
    url: BASE_URL,
    // Never reuse a leftover `swap` on :5151 by default — a stale process
    // (wrong env, old embed, hung streams) makes local Mac runs hang until the
    // 90s test timeout. Opt in with PLAYWRIGHT_REUSE=1 when debugging against a
    // hand-started server. CI always starts fresh.
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE === "1",
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // No `?id=` gate (clean URLs) and don't pop a real browser open.
      SWAP_NO_AUTH: "1",
      NO_BROWSER_OPEN: "1",
    },
  },
});

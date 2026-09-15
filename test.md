# Tests

All commands run from the repo root. Bun is required.

## Overview

| Type            | Command                              | Network / keys        |
|-----------------|---------------------------------------|----------------------|
| Typecheck       | `bun run typecheck`                   | no                  |
| Unit            | `bun run test` (or `bun test tests/*.test.ts`) | no           |
| Self-checks     | `bun run web/src/dapp/urlState.ts` · `bun run src/venues/ophis.ts` | no |
| Hosted smoke    | `SWAP_API_URL=http://127.0.0.1:5152 bun run src/index.ts …`     | no external network (local `vercel-smoke.ts`) |
| E2E dApp        | `bun run test:e2e`                    | yes (`.env` filled in)  |

## Typecheck

```bash
bun run typecheck      # tsc --noEmit on the whole project
```

## Unit tests (`bun test`)

```bash
bun run test                     # all unit tests (tests/*.test.ts)
bun test tests/hops_approx.test.ts   # a single file
bun test tests/hosted_mode.test.ts   # hosted mode (--hosted / --local / SWAP_API_URL / SWAP_API_DISABLED) offline unit tests
```

`tests/hosted_mode.test.ts` stubs `fetch` and covers `src/remote.ts` end to
end without a network call: `resolveApiBase` precedence
(`--local` > `--hosted` > `SWAP_API_DISABLED=true` > `SWAP_API_URL` >
local engine, including the strict boolean parsing of `SWAP_API_DISABLED`),
the wire to
`NormalizedQuote` mapping (`routeQuoteToNormalized`), the NDJSON stream
reader (`venueResultsFromNdjson`, including a line split across chunk
boundaries), the `apiVersion` mismatch check, and the 429 / unreachable-API
error messages.

⚠️ Do not run `bun test` **without an argument**: Bun's runner also picks up
the Playwright specs (`tests/e2e/*.spec.ts`) and crashes (two incompatible
runners). Use `bun run test` or a `tests/*.test.ts` glob.

## Self-checks (offline, built in via `import.meta.main`)

```bash
bun run web/src/dapp/urlState.ts   # deep-link router round-trip → "urlState self-check: OK"
bun run web/src/dapp/iconCache.ts  # icon key / persistable-URL checks → "iconCache self-check: OK"
bun run src/venues/ophis.ts        # canonical appData + eth-flow calldata → "ophis self-check: OK"
```

## Hosted mode smoke (`--hosted` / `SWAP_API_URL` against a real API shape)

`tests/hosted_mode.test.ts` covers `src/remote.ts` offline, but it stubs
`fetch`: it never exercises the CLI against an actual `/api/*` response
shape. For that, point the CLI at the same local `vercel-smoke.ts` server
used for the Vercel smoke test (see [docs/vercel.md](docs/vercel.md#local-test-before-deploying)):

```bash
SWAP_DISABLE_VENUES=curve bun run scripts/vercel-smoke.ts &
sleep 2

SWAP_API_URL=http://127.0.0.1:5152 bun run src/index.ts 2000 weth steth -v all

kill %1  # stop the smoke server
```

Check every row of the comparison table: this is the same command used as
the CLI's general pre-release smoke test, run once against the local engine
and once against `vercel-smoke.ts` through `SWAP_API_URL` to confirm the
hosted client reads the live wire shape correctly.

## E2E — interactive dApp (Playwright)

100,000 USDC → USDT on Ethereum mainnet, venue by venue, driving the real
dApp (`swap` with no argument → embedded server + `/api/*`). Each venue is
isolated via the Settings popover (⚙ → Disable all → enable a venue → Done),
then we check it returns a usable route (~100,000 USDT). One test per venue in
`VENUE_CASES`; key-gated venues need their key present and valid in `.env`
(e.g. matcha fails without a working `ZEROEX_API_KEY`). A case carrying a
`skip` reason is declared with `test.skip` — currently `odos` and `odosv2`
(Odos discontinued its app and API on 2026-07-30, so the dApp no longer offers
them).

**Prerequisites:**
- `.env` filled in (`ALCHEMY_API_KEY` + per-venue keys: `ONEINCH_API_KEY`,
  `UNISWAP_API_KEY`, `OPENOCEAN_API_KEY`, `OPHIS_REFERRAL_CODE`, …).
- Google Chrome installed (the config uses `channel: "chrome"`, no
  Playwright browser download).
- The dApp bundle must be up to date: if `web/src` changed, rebuild with
  `cd web && bun run build` (tests run against `web/dist`, the embedded
  artifact — not a Vite dev server).

The dApp server is started/stopped automatically by Playwright (`webServer`
in `playwright.config.ts`, `SWAP_NO_AUTH=1`, port 5151). A `swap` server
left running on :5151 is **no longer reused** (it was causing Mac runs to
hang) — Playwright starts a fresh one. To replay against an already-running
server: `PLAYWRIGHT_REUSE=1 bun run test:e2e`.

**Mac:** having Google Chrome installed is enough (`channel: "chrome"`). If
a run times out at 90s, kill any leftover process: `lsof -i :5151` then
`kill <pid>`.

```bash
bun run test:e2e                  # headless, full battery (smoke + 14 venues, 2 skipped)
bun run test:e2e -g Curve         # a single venue
bun run test:e2e -g "smoke|KyberSwap"   # a subset
bun run test:e2e:headed           # visible browser (needs a DISPLAY)
```

Headless machine (server/CI) for headed mode → virtual display:

```bash
xvfb-run -a bun run test:e2e:headed
```

**Reports:** `list` on the console + HTML report in `playwright-report/`
(`bunx playwright show-report`). On failure: trace + screenshot in
`test-results/`. These directories are gitignored.

### Adding / removing a venue

The tested list is in `tests/e2e/helpers.ts` (`VENUE_CASES`) — each entry
maps the backend name to the label shown by the dApp (see
`web/src/dapp/venues.ts`) and its `kind` (`sync` / `async`). The spec
(`tests/e2e/venues.spec.ts`) generates one test per entry.

# swap — agent guide

Terminal CLI (`swap`) that queries DEX-aggregator APIs for the best swap quote on
EVM chains and can build the executable transaction. The same engine powers a
`--browser` sign-only bridge and a full interactive web dApp (`swap` with no
args), which also deploys to a serverless target. Bun + TypeScript throughout;
native `fetch` only.

## Run / typecheck / build / test

- **Dev**: `bun run src/index.ts 1 WBTC ETH`
- **Typecheck**: `bun run typecheck`
- **Build standalone binary**: `./build` → produces `dist/swap`
- **Public redistributable build**: `SWAP_PUBLIC_BUILD=1 ./build` (or `./build-all`) — embeds `.env.install` (not `.env`); publish with `./deploy.sh` (build + upload) or `./scripts/publish-cli.sh` (upload `dist/` as-is)
- **Smoke test** (run before claiming any feature complete — check every
  comparison row): `bun run src/index.ts 2000 weth steth -v all`

Bun is required both at dev time and to compile the binary. `axios` is in
`package.json` only because `@1inch/fusion-sdk` imports it statically; we never
call it.

## Layout at a glance

```
src/index.ts         entry point: commander wiring + orchestration
src/update.ts        `swap update` (pre-commander): fetch the `.sha256` manifest first and skip when the installed binary already matches, else download latest Blob prebuilt, verify, atomic replace
src/core.ts          commander-free composition layer (shared by the dApp handlers)
src/remote.ts        hosted mode (`--hosted` / `SWAP_API_URL`): `/api/*` client replacing the local engine for quote + build
src/chains.ts        chain alias table; src/tokens.ts token resolution; src/amount.ts units
src/trade_side.ts    sell/buy side, BUY_CAPABLE_VENUES; src/slippage.ts min-out/max-in
src/format.ts json.ts   terminal + JSON renderers (consume only NormalizedQuote)
src/wrap.ts send.ts unstake_savax.ts claim_savax.ts   short-circuit actions (skip the venue loop)
src/simulate.ts      --simulate (eth_simulateV1 prank); src/gas_usd.ts gas-USD fallback
src/rpc.ts checksum.ts env.ts referral.ts   RPC resolution, EIP-55, .env, partner fees
src/venues/          per-venue adapters + dispatcher (fetchAllQuotes, pickBest, build)
src/browser.ts serve.ts server/   --browser bridge, dApp server, stateless handlers
api/ vercel.json     serverless functions + config
web/                 Vite + React + RainbowKit dApp (separate package)
```

## Where to read more

- [docs/architecture.md](docs/architecture.md) — layout, `NormalizedQuote`,
  quote→pick→build pipeline, output modes, tx build (`-d`), allowance/priority
  fee, RPC resolution, spender field, token resolution, chains, short-circuit
  actions, gas-USD fallback, simulation.
- [docs/venues.md](docs/venues.md) — venue adapter contract, per-venue
  quote/build specifics, exact-out & trade side, async (intent) venues, the
  `permit-tx` build kind, external-API inventory, referral / partner fees.
- [docs/dapp.md](docs/dapp.md) — interactive dApp, the stateless `/api/*`
  contract, client-side curve, the `--browser` flow and page components, and the
  serverless-target constraints.
- [docs/conventions.md](docs/conventions.md) — native sentinel, address casing,
  bigint-as-string, error handling, decimals safety, no-silent-catch,
  no-public-RPC-fallback, key loading.
- [docs/vercel.md](docs/vercel.md) — serverless deployment steps and env vars.
- [docs/quote-accuracy.md](docs/quote-accuracy.md) — quote vs. execution accuracy
  investigation for sync venues.
- [test.md](test.md) — typecheck, unit tests, offline self-checks, and the
  Playwright e2e battery (one test per venue against the real dApp).

## Non-negotiable rules for contributors / agents

- **Decimals are safety-critical.** Never guess or coerce `decimals` to `18`; a
  wrong value corrupts calldata by 10^N. If it can't be resolved, fail loud.
- **Read `tx.spender`, never `tx.to`,** when reasoning about which address needs
  the ERC20 approval — Velora's spender diverges.
- **Native token = the sentinel `0xeee…eee`** internally; adapters translate at
  their boundary. Addresses are lowercased before comparison.
- **No silent catches.** Log every error; non-critical paths (e.g. priorityFee)
  degrade to `null` rather than aborting.
- **No public RPC fallbacks in the CLI.** Missing RPC config is a hard failure
  with the exact env var to set. The dApp server last-resorts to the shared
  PublicNode table when Alchemy and per-chain overrides are unset.
- **Same slippage for quote and build.** Evaluating them at different slippage
  makes the displayed route/`amountOut` diverge from what the tx executes.
- **The quote-only `0x…dEaD` placeholder never enters a signed order.** Async
  builds always re-quote with the real sender.
- **Async venues (cow/delta/uniswapx/fusion) require `--allow-async`** — they
  change output semantics (sign + POST vs. broadcast a tx).
- **Commit messages carry no `Co-Authored-By: Claude` trailer.**

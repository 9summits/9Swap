# swap

**`swap`** is a terminal CLI that asks every major DEX aggregator (KyberSwap,
Velora, 0x/Matcha, 1inch, Curve, OpenOcean, plus intent-based venues
like CoW (and its Ophis fork), UniswapX, Velora Delta, 1inch Fusion) for a
swap quote on EVM chains, ranks the answers by token-out received, and —
optionally — builds the executable calldata, checks your allowance, and
simulates the trade against your pranked balance before you sign anything.

It's a single Bun-compiled binary with no daemon, no UI, and no telemetry.
You run `swap 1 WBTC ETH` and it prints the route, rate, gas, and tx data.

```
swap 1 WBTC ETH                                              # quote, ranked across venues
swap 1000 USDC USDT -v all                                   # comparison block
swap 100 USDC USDT -v all --from 0x… --simulate              # eth_simulateV1 with pranked balance
swap 1 ETH WETH                                              # auto-wrap (no venue, direct deposit())
swap 100 USDC -a send --to 0xRECIP --from 0xSEND -d          # token transfer (no swap)
swap 0.1 WETH USDC --from 0xMyAddr --browser                 # sign + send via local RainbowKit page
```

## Install

### One-shot (recommended)

```sh
curl -fsSL https://swap.9summits.io/install.sh | bash
```

This downloads a prebuilt `swap` binary for your OS/arch into `~/.local/bin`
(override with `SWAP_INSTALL_DIR`). Supported platforms: **macOS** (arm64, x64)
and **Linux** (arm64, x64). Re-run the same command to upgrade, or after
install run `swap update` to replace the binary in place from the same source.

After install:

```sh
swap --help
swap update          # pull the latest public prebuilt (no-op when already current)
swap 100 USDC WETH
```

The installed binary is **hosted by default**: it quotes and builds through
`https://swap.9summits.io/api/*` (`--hosted`), so every venue works with zero
key configuration and no RPC, except `--simulate`. Pass `--local` (or clear
`SWAP_API_URL`) to switch to the local engine with your own venue keys and
RPC.

First run may prompt for an Alchemy key / RPC URL (saved under `~/.swap`) if
the command you ran needs one. If `~/.local/bin` is not on your `PATH`, the
installer prints the line to add to your shell profile.

**Note:** the CLI binary is `swap` (config still under `~/.swap`). A short-lived
`swag` rename was reverted — reinstall with the one-liner above if you still
have a `swag` binary on your PATH.

Prebuilt binaries live behind `https://swap.9summits.io/cli`, which 302s to
Vercel Blob. Both the install script and `swap update` download through that
redirect. The binaries are built with
`SWAP_PUBLIC_BUILD=1`, which embeds the curated
**`.env.install`** file (venue keys, referrals, …) into the binary — not your
personal `.env`. RPC / Alchemy keys are still excluded from the embed;
install users configure those via first-run / `swap --init`. `.env.install`
is gitignored — only put keys you accept shipping to every installer.

The install script is on the dApp host at
`https://swap.9summits.io/install.sh`.

### Maintainers

Releases are published from a maintainer machine that has `.env.install`
and `BLOB_READ_WRITE_TOKEN`: `./deploy.sh` (build + upload) or
`./scripts/publish-cli.sh` (upload whatever is already in `dist/`).

```sh
vercel env pull .env.blob --environment production
./deploy.sh
```

Env knobs for the installer:

| Variable | Default | Effect |
|----------|---------|--------|
| `SWAP_INSTALL_DIR` | `~/.local/bin` | install destination |
| `SWAP_INSTALL_BASE` | `https://swap.9summits.io/cli` | alternate asset base |

### Build from source

Requires [Bun](https://bun.sh).

```sh
git clone https://github.com/9summits/9Swap.git && cd 9Swap
bun install
cp .env.example .env && $EDITOR .env       # paste your API keys (optional)
./build                                    # produces dist/swap
# optional: put it on PATH
mkdir -p ~/.local/bin && ln -sf "$PWD/dist/swap" ~/.local/bin/swap
```

If a `.env` exists at build time, its values are **embedded into the
compiled binary** so `swap` works from any directory without copying
`.env` around. The build script prints a one-line summary of which keys
were embedded plus a warning — the binary contains those values, so
don't redistribute it. Use `SWAP_PUBLIC_BUILD=1 ./build` (or `./build-all`)
for a redistributable binary with no secrets baked in. Shell env and a
`.env` in the current directory still override embedded values at runtime.

Cross-compile every supported target: `./build-all` → `dist/swap-<os>-<arch>`.

For development, skip the build and run `bun run src/index.ts <args>`.

## Quickstart

```
swap <amount> <tokenIn> [tokenOut] [flags]
```

`tokenIn` / `tokenOut` accept either a symbol (`WBTC`) or a `0x` address.
`<amount>` is in human units (`1.5`, `0.001`); `max` swaps the sender's full
balance. By default amount is **tokenIn**; with `--exact-out` it is **tokenOut**
(buy: receive that amount, pay as little tokenIn as possible). `tokenOut` is
optional with `-a send`.

Common flags:

| Flag | Effect |
|------|--------|
| `-a, --action <action>` | `swap` (default — quote + build) or `send` (transfer the input token to `--to`, no DEX) |
| `--to <addr>` | recipient address; required with `-a send` |
| `-v <venue>` | one of `kyber`, `velora`, `matcha`, `1inch`, `curve`, `uniswap`, `openocean`, `cow`, `delta`, `uniswapx`, `fusion`, `ophis`, or `all` (default `all`). Comma-separated list also works — e.g. `-v kyber,velora,matcha` races just those three and prints a 3-row comparison block. Bypassed entirely when `tokenIn`/`tokenOut` are the native↔wrapped pair (auto wrap/unwrap) or `-a send` |
| `--all` | alias for `-v all` (kept for muscle memory) |
| `--allow-async` | include intent-based venues (`cow`, `delta`, `uniswapx`, `fusion`, `ophis`) — output is an EIP-712 order to sign + POST, not a tx |
| `--chain <alias>` | `eth` (default), `arc`, `arb`, `base`, `op`, `avax`, `bsc`, `hype`, `unichain`, `robinhood`, `monad`, `plasma`, `polygon`, `gnosis`, `ink` |
| `--slippage <pct>` | percent, e.g. `0.5` for 50 bps. Default `0.1` |
| `--exact-out` | amount is denominated in **tokenOut** (buy exact-out): minimize tokenIn paid to receive that amount. Rejected for send/wrap/special actions |
| `--from <addr>` | sender address (also reads `SENDER_ADDRESS`); required for `-d`, `--simulate`, `--browser`, `max` |
| `-d`, `--data` | additionally build the swap tx (calldata, target, value, gas, allowance check, approve tx) |
| `--simulate` / `--simu` | run the swap in `eth_simulateV1` against pranked balances; reports actually-received tokenOut |
| `--browser` | open a local RainbowKit page to connect a wallet and send/sign — covers sync tx, async orders, and Uniswap V4 / split / mixed routes (Permit2 sign-then-assemble). Mutually exclusive with `--json` and `--simple` |
| `--json` | structured machine-readable output |
| `-s`, `--simple` | print only the numeric `amountOut` for shell piping |
| `--hosted` | quote and build through the hosted API (`https://swap.9summits.io`) for this run instead of the local engine; no venue key, no RPC except `--simulate`; mutually exclusive with `--local` |
| `--local` | force the local engine for this run even when `SWAP_API_URL` is set, using your own venue keys and RPC |
| `--show-mode` | print the effective mode (`hosted <base>` or `self-hosted`) on stdout and exit, without quoting |
| `-V`, `--version` | print the version and the commit the binary was built from (`swap 0.1.0 (2c02339, 2026-09-15)`) and exit, without quoting |

## Output modes

**Default (terminal)** — route tree, rate / gas / chain / venue / router / tokens
rows, then a bold summary line. With `-v all`, a `venues` comparison block
appears below; while quotes race, the live block streams sorted desc by
`amountOut` with `★` on the current leader.

**`--data` (`-d`)** — adds an `approve tx` block (only when allowance is
insufficient) and a `swap tx` block with calldata bytes ready to broadcast.
For async venues you get an `order` block instead — sign the EIP-712 typed
data and POST to the venue's submit URL.

**`--simulate`** — runs the built tx (approve + swap) against a pranked
sender balance via `eth_simulateV1`, then appends a `simulation` block with
gas used, revert reason if any, and the actually-received tokenOut. Calldata
blocks stay hidden unless you also pass `-d`.

**`--json`** — single object with `quotes`, `best`, `tx`, `order`, `approval`,
`simulation`. Errors are emitted as `{"error": "..."}` with exit 1.

**`--simple` / `-s`** — just the human-units variable leg for piping: `amountOut`
by default, or `amountIn` when `--exact-out` (you already chose the receive
amount). For `x=$(swap 1 WBTC ETH -s)` style piping.

## Send (`-a send`)

Skip the venue loop entirely and produce a direct token transfer to `--to`.
Useful when you want the same calldata-builder + `--browser` flow as a swap
but without DEX routing.

```sh
# ERC20 transfer — emits transfer(0xRECIP, amountIn) on the token contract
swap 100 USDC -a send --to 0xRECIP --from 0xSEND -d

# Native — emits a value-only tx (data="0x")
swap 0.5 ETH -a send --to 0xRECIP --from 0xSEND -d
```

`tokenOut` is ignored under `-a send` (warned, not blocked). No allowance
check fires — `transfer` operates on the sender's own balance, native send
carries the value via `msg.value`.

## Wrap / unwrap

When `tokenIn` and `tokenOut` form the native↔wrapped pair on the chain
(`ETH ↔ WETH` on mainnet/arb/base/unichain, `BNB ↔ WBNB`, `AVAX ↔ WAVAX`,
`HYPE ↔ WHYPE`, `POL ↔ WPOL`, `XDAI ↔ WXDAI`), `swap` short-circuits the venue loop — the rate is 1:1 by
construction, so going through an aggregator just wastes gas. Direct calls:

- **wrap**: `deposit()` (`0xd0e30db0`) on WETH9 with `value = amountIn`
- **unwrap**: `withdraw(uint256)` (`0x2e1a7d4b` + 32-byte amount) on WETH9

```sh
swap 1 ETH WETH -d --from 0xMyAddr     # wrap
swap 1 WETH ETH -d --from 0xMyAddr     # unwrap
swap 1 BNB WBNB --chain bsc -d --from 0xMyAddr
```

No allowance check in either direction — `withdraw()` operates on
`msg.sender`'s own WETH balance.

## Venues

Sync (broadcastable tx): `kyber`, `velora`, `matcha`, `1inch`, `curve`,
`uniswap`, `openocean`.

Async (intent / EIP-712 order): `cow`, `delta`, `uniswapx`, `fusion`, `ophis`.
Require `--allow-async`. The build path produces an `order` payload to sign
and POST off-chain; a filler/solver settles the order on-chain inside the
order's validity window.

### Availability by chain

✓ served, · not served. Under `-v all` only the venues serving the selected
chain are raced; the rest are skipped silently. Snapshot of the adapters'
chain tables (`*_SUPPORTED_CHAIN_IDS` / chain maps in `src/venues/*.ts`).

| Venue | eth | arc | base | arb | op | unichain | bsc | avax | hype | robinhood | monad | plasma | polygon | gnosis | ink |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `kyber` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| `velora` (sync) | ✓ | · | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | · | · | · | ✓ | ✓ | · |
| `matcha` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | ✓ | · | ✓ |
| `1inch` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `curve` (sync) | ✓ | · | ✓ | ✓ | ✓ | · | · | ✓ | · | · | · | · | · | ✓ | · |
| `uniswap` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | ✓ | · | ✓ |
| `openocean` (sync) | ✓ | ✓ | ✓ | ✓ | · | · | ✓ | ✓ | · | ✓ | · | · | ✓ | ✓ | · |
| `cow` (intent) | ✓ | · | ✓ | ✓ | · | · | · | · | · | · | · | · | ✓ | ✓ | ✓ |
| `ophis` (intent) | ✓ | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | ✓ | ✓ | ✓ | ✓ |
| `delta` (intent) | ✓ | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · | ✓ | · | · |
| `uniswapx` (intent) | ✓ | · | ✓ | ✓ | · | ✓ | · | · | · | · | · | · | · | · | · |
| `fusion` (intent) | ✓ | · | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | ✓ | ✓ | · |
| *venues per chain* | 12 | 5 | 12 | 12 | 9 | 8 | 9 | 10 | 2 | 7 | 5 | 3 | 10 | 7 | 4 |

API keys below are only needed with `--local` (self-host, your own venue
keys); the default hosted mode already has every key-gated venue enabled
server-side. Place them in `.env`, `cp .env.example .env` to start:

| Venue | Env var | Free signup |
|-------|---------|-------------|
| `matcha` | `ZEROEX_API_KEY` | https://dashboard.0x.org |
| `1inch`, `fusion` | `ONEINCH_API_KEY` | https://portal.1inch.dev |
| `uniswap`, `uniswapx` | `UNISWAP_API_KEY` | https://hub.uniswap.org |
| `ophis` | `OPHIS_REFERRAL_CODE` | rebate code (CIP-75 program) — venue skipped without it |

`kyber` is keyless on the public host (3 rps); an optional `KYBER_API_KEY`
(from business@kyber.network) routes it through the API gateway with higher
limits, and `KYBER_SOURCE` / `KYBER_REFERRAL` add free-form on-chain
attribution on the build. See `.env.example`.

`openocean` is keyless on the public host (2 rps). An optional
`OPENOCEAN_API_KEY` (https://docs.openocean.finance/docs/swap-api/enterprise)
switches it to the pro host.

Venues without a key are skipped under `-v all` (a stderr note names the
missing env vars). Querying them directly (`-v matcha`) raises a clear error
pointing at the signup URL.

## Exact-out (`--exact-out`)

With `--exact-out` the `<amount>` is the **tokenOut** you want to receive and
the CLI ranks venues by the least **tokenIn** paid (ties: most **tokenOut**).

**Two-pass race:**

1. **Native buy** — venues with a real EXACT_OUTPUT / BUY path
   (`BUY_CAPABLE_VENUES` in `src/trade_side.ts`).
2. **Sell refine** — sell-only venues are re-quoted as exact-in at the best
   native-buy pay (`amountIn` seed). Survivors must deliver `amountOut ≥`
   the receive target; build stays exact-in with a min-out floor at that
   target (never a silent under-delivery vs what you typed).

Selecting a sell-only venue alone (`-v kyber --exact-out`) still raises
`UnsupportedSideError` — refine only runs in a multi-venue race that also
has a native-buy seed. `/api/mode` `buyVenues` lists **native** buy venues
only (capability contract); refined routes are tagged `buyRefine` on the
quote wire.

| Venue | Exact-out | Note |
|-------|:---------:|------|
| `velora` | ✅ native | BUY side |
| `matcha` | ✅ native | 0x `buyAmount` |
| `uniswap` | ✅ native | Trading API `EXACT_OUTPUT` |
| `cow` | ✅ native | `kind: buy` order — needs `--allow-async` |
| `ophis` | ✅ native | `kind: buy` order — needs `--allow-async` |
| `kyber` | ♻️ refine | sell-only API; multi-venue seed only |
| `1inch` | ♻️ refine | sell-only API; multi-venue seed only |
| `curve` | ♻️ refine | sell-only (`get_dy` is exact-in) |
| `openocean` | ♻️ refine | sell-only API; multi-venue seed only |
| `delta` | ♻️ refine | sell-only; needs `--allow-async` |
| `uniswapx` | ♻️ refine | sell-only; needs `--allow-async` |
| `fusion` | ♻️ refine | sell-only; needs `--allow-async` |

## Hosted mode

By default `swap` quotes and builds through `https://swap.9summits.io/api/*`
instead of the local venue engine: no venue key and no RPC needed for a plain
quote or a `-d` build, and every key-gated venue (1inch, Fusion, Matcha/0x,
Uniswap, UniswapX) works out of the box. `--simulate` and the local-only
actions (`send`, `unwrapwrseth`, `withdrawsparkweth`, `unstakesavax`,
`claimsavax`) still run against your own RPC.

Resolution order: `--local` > `--hosted` > `SWAP_API_DISABLED=true` >
`SWAP_API_URL` > local engine. The public prebuilt binary embeds
`SWAP_API_URL=https://swap.9summits.io`. To self-host with your own venue keys
and RPC, pass `--local` for one run, set `SWAP_API_DISABLED=true`, or clear
`SWAP_API_URL` (unset it in the shell, `.env`, or `~/.swap/config`).

`swap --show-mode` prints which backend the current configuration resolves to,
one line on stdout: `hosted https://swap.9summits.io` or `self-hosted`. It takes
no positional argument and never quotes, and `--hosted` / `--local` alongside it
are honoured (`swap --show-mode --local` prints `self-hosted`).

| Variable | Default | Effect |
|----------|---------|--------|
| `SWAP_API_URL` | `https://swap.9summits.io` (baked into the public binary) | Base URL of a `/api/*` deployment the CLI quotes and builds through. Empty/unset disables hosted mode |
| `SWAP_API_DISABLED` | `false` | `true` forces the local engine with your own keys and RPC even when `SWAP_API_URL` is set, so an embedded URL can be opted out of without finding and clearing it. Accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`; any other value is an error |

In hosted mode `--nofee` is refused (fee policy is server-side), the venue
list comes from `GET /api/mode` (`curve` is not offered there), and a stale
binary whose `apiVersion` no longer matches the deployment fails with
`hosted API contract mismatch … run swap update`. The CLI never falls back to
the local engine silently: an unreachable or rate-limited API fails loud and
points at `--local`. No telemetry is added (the CLI still never calls a
`/done` endpoint), but the hosted server does see the caller's IP, the pair,
the amounts, and the `--from` address on a build, the same as the web dApp.

## RPC

`-d` / `--simulate` need RPC access for allowance reads, gas-price lookups,
and `eth_simulateV1` when running against the local engine (`--local` or
`SWAP_API_URL` unset). Hosted mode needs none of that for a plain quote or
build; only `--simulate` still calls your own RPC. Resolution order:

1. `RPC_URL_<chainId>` (e.g. `RPC_URL_1`)
2. `<ALIAS>_RPC_URL` (e.g. `ETH_RPC_URL`, `ARB_RPC_URL`)
3. `ALCHEMY_API_KEY` — one key covers every supported chain. Free tier is enough.

The CLI has **no public RPC fallbacks**. It hard-fails with the exact env var
name to set. Public RPCs rate-limit aggressively and give inconsistent
allowance reads, which silently breaks the build path. The dApp server
last-resorts to the shared PublicNode table when Alchemy and per-chain
overrides are unset.

## Sender address

`-d`, `--simulate`, and `amount=max` all require a sender:

1. `--from <addr>` flag
2. `SENDER_ADDRESS` env var

There is no placeholder default — the sender is the swap's output recipient,
so silently defaulting risks signing a tx that sends tokens to an
unrecoverable address. The address is normalized to EIP-55 checksum (Velora
rejects non-checksummed addresses).

## Slippage

`--slippage` is a percent. Default `0.1` (10 bps). The same value drives both
the quote and the build: some venues let slippage steer route search, so
quoting at one slippage and building at another would diverge.

## Referral fees

The sync venues and CoW support permissionless fee attribution. Set
`REFERRAL_ADDRESS` to your recipient and optionally `REFERRAL_FEE_BPS` (1 bp
= 0.01%, capped at 1000). Velora additionally enables `takeSurplus=true`
whenever `REFERRAL_ADDRESS` is set — invisible to the user, skims positive
slippage. Kyber also sends `feeReceiver` at 0 bps so the receiver is
registered. See `.env.example` for the full set.

## Examples

```sh
# basic quote — every venue, ranked by amountOut (default)
swap 1 WBTC ETH

# pin a single venue
swap 1 WBTC ETH -v kyber

# include intent venues (CoW, UniswapX, Velora Delta, 1inch Fusion)
swap 2 WETH stETH --all --allow-async

# build broadcastable calldata
swap 100 USDC USDT -v kyber --from 0xMyAddr -d

# simulate — actual tokenOut received against pranked balance
swap 100 USDC USDT --from 0xMyAddr --simulate

# wrap / unwrap (no venue, direct WETH9 deposit/withdraw)
swap 1 ETH WETH -d --from 0xMyAddr
swap 1 WETH ETH -d --from 0xMyAddr

# send a token (no DEX)
swap 100 USDC -a send --to 0xRECIP --from 0xSEND -d
swap 0.5 ETH  -a send --to 0xRECIP --from 0xSEND -d

# BNB Chain
swap 1000 USDT USDC --chain bsc -v all
swap 1 BNB WBNB --chain bsc -d --from 0xMyAddr

# sign + send via local browser (works for swap / wrap / send / Uniswap V4)
swap 0.1 WETH USDC --from 0xMyAddr --browser

# pipe just the number into another script
RATE=$(swap 1 WBTC ETH -s)

# JSON for tooling
swap 1 WBTC ETH --all --json | jq '.best'
```

## Browser sign-and-send (`--browser`)

`--browser` builds the swap as it would for `-d`, then starts a tiny local
server on `127.0.0.1:5151` (falls back to a random port if busy) and opens
your default browser at it. The served page is a Vite-bundled React app with
[RainbowKit](https://www.rainbowkit.com/) that:

- shows the quote summary, with action-aware labels (wrap/unwrap shows
  "wrap N ETH → N WETH", send shows "to `<recipient>`" instead of swap rows),
- offers Connect Wallet (MetaMask, Rabby, WalletConnect, …),
- **gates actions on wallet match** — if the connected wallet ≠ `--from`, the
  page hard-blocks signing/sending with a red panel showing both addresses
  (the calldata recipient is hard-bound to `--from`),
- offers a **simulate** button — runs `eth_simulateV1` on the local server
  with a pranked balance and shows actual tokenOut, gas, and any revert
  reason before you sign,
- pre-fills the swap tx (or, for async venues, the EIP-712 typed-data sign
  and POST to the relayer; or, for Uniswap V4 / split / mixed routes, signs
  a Permit2 PermitSingle and POSTs to a local `/assemble` endpoint that
  hits Uniswap's `/v1/swap` with the API key on the server side, then
  broadcasts the returned tx),
- reports the resulting tx hash / order id back to the CLI, which prints it
  and exits.

```sh
swap 100 USDC USDT --from 0xMyAddr --browser
swap 1000000 USDC WETH --from 0xMyAddr --browser    # Uniswap V4 / split → Permit2 sign + assemble
swap 100 USDC -a send --to 0xRECIP --from 0xMyAddr --browser
```

The bundle is embedded in the binary at build time (`web/` source → vite-singlefile
→ `web/dist/index.html` → text-imported by `src/browser.embedded.ts`). Optional
`WALLETCONNECT_PROJECT_ID` env var enables WalletConnect; without it only
injected wallets work, which is enough for most setups.

`--browser` also works in hosted mode: the tx/order is built through the
hosted API and the local bridge server proxies the `/assemble` and `/submit`
legs to it, so nothing is signed anywhere but your own browser.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for the contributor-oriented walkthrough:
adapter contract (`NormalizedQuote`), per-venue quirks (Velora's
`tokenTransferProxy`, Curve's RouterNG wrap path, RouterNG vs RateProvider,
async order signing), token resolution (KyberSwap → CoinGecko → on-chain
`decimals()`), simulation slot probe, and chain-add checklist.

## Agent / LLM discovery (AEO)

The public dApp host serves machine-readable discovery files (copied from
`web/public/` by the Vite Vercel build):

| File | Purpose |
|------|---------|
| [`/llms.txt`](https://swap.9summits.io/llms.txt) | Compact product + API index ([llmstxt.org](https://llmstxt.org/)) |
| [`/llms-full.txt`](https://swap.9summits.io/llms-full.txt) | Full API/CLI context for agents |
| [`/robots.txt`](https://swap.9summits.io/robots.txt) | Crawl rules; explicitly allows major AI crawlers |
| [`/sitemap.xml`](https://swap.9summits.io/sitemap.xml) | Public URL list |

Repo-level guidance for coding agents: [AGENTS.md](./AGENTS.md) (points at
these files and the safety rules also in `CLAUDE.md`). The SPA does not
emit Markdown mirrors of UI routes; keep product facts in `llms*.txt`.

## License

[Apache-2.0](./LICENSE). Copyright 2026 9Summits — see [NOTICE](./NOTICE).

# swap — CLI manual

> Terminal CLI that races every major EVM DEX aggregator for a swap quote, ranks by token-out received, and optionally builds calldata, simulates, or hands the tx to a wallet. Single Bun-compiled binary. No daemon, no telemetry. Operator: 9summits. Source: https://github.com/9summits/9Swap (Apache-2.0).

HTML version: https://swap.9summits.io/docs · Machine index: https://swap.9summits.io/llms.txt · HTTP API: https://swap.9summits.io/openapi.json · Agent skill: https://swap.9summits.io/skills/swap-cli/SKILL.md

```sh
swap 1 WBTC ETH                                  # best quote across every venue
swap 1000 USDC USDT -v all                       # side-by-side comparison block
swap 100 USDC USDT --from 0xYou --simulate       # dry-run, real tokenOut
swap 0.1 WETH USDC --from 0xYou --browser        # sign & send in your wallet
swap                                             # no args: open the local dApp
```

## 01 · Install & setup

```sh
curl -fsSL https://swap.9summits.io/install.sh | bash     # macOS / Linux, arm64 + x64 → ~/.local/bin/swap
swap update                                               # self-update the curl install (no-op when current)
swap --init                                               # prompt for ALCHEMY_API_KEY or an RPC URL → ~/.swap/config
```

Installer env: `SWAP_INSTALL_DIR` (default `~/.local/bin`), `SWAP_INSTALL_BASE` (asset base), `SWAP_NO_PROGRESS=1`.

The public prebuilt binary is **hosted by default**: it quotes and builds through `https://swap.9summits.io/api/*` (`--hosted`), so every venue works with zero key configuration. Building a tx, `--browser` and `max` still need a sender address but no RPC in hosted mode; only `--simulate` and the local-only actions still call your own RPC. Pass `--local` (or set `SWAP_API_DISABLED=true`) to switch to the local engine and your own venue keys (see 09). The first-run RPC prompt only fires on an interactive terminal and only when the run actually needs an RPC; in scripts and agents nothing ever blocks on stdin.

## 02 · Usage & flags

```
swap [options] <amount> <tokenIn> [tokenOut]
```

- `amount` — human units (`1.5`, `0.001`). `max` = the sender's whole balance (needs `--from` + RPC). Denominates **tokenIn**, or **tokenOut** with `--exact-out`.
- `tokenIn` / `tokenOut` — symbol (case-insensitive) or `0x` address. Unknown symbols resolve via KyberSwap → CoinGecko → on-chain `decimals()`. Native gas token: `ETH`, `BNB`, `AVAX`, `HYPE`, `MON`, `XPL`, `POL`, `XDAI` by chain.
- `tokenOut` is optional only with `-a send`.

| Flag | Effect |
|------|--------|
| `-v, --venue <list>` | One venue, a comma list (`kyber,matcha,1inch`), or `all` (default). `--all` = `-v all`. |
| `-c, --chain <alias>` | `eth` (default), `base`, `arb`, `op`, `avax`, `bsc`, `hype`, `unichain`, `robinhood`, `monad`, `plasma`, `polygon`, `gnosis`, `ink`. |
| `--slippage <pct>` | Percent; `0.5` = 50 bps. Default `0.1`. Same value drives quote and build. |
| `--from <addr\|alias>` | Sender and recipient. Required for `-d`, `--simulate`, `--browser`, `max`. Falls back to `$SENDER_ADDRESS`. Accepts a wallet alias. |
| `-d, --data` | Build the tx: target, calldata, value, gas params, allowance check, approve tx when needed. |
| `--simulate` / `--simu` | `eth_simulateV1` with a pranked tokenIn balance: approve + swap, actual tokenOut, revert reason. Sync venues only. |
| `--browser` | Local RainbowKit page to connect a wallet and sign/send. Exclusive with `--json` / `-s`. |
| `--allow-async` | Include intent venues (`cow`, `delta`, `uniswapx`, `fusion`, `ophis`). Output is an EIP-712 order, not a tx. |
| `--exact-out` | `amount` is tokenOut to receive; minimise tokenIn. Not for send / wrap / special actions. |
| `-a, --action <name>` | `swap` (default), `send`, `addwallet`, `unwrapwrseth`, `withdrawsparkweth`, `unstakesavax`, `claimsavax`. |
| `--to <addr\|alias>` | Recipient for `-a send`. |
| `--rpc <url>` | Override the RPC for this run (beats every env var). |
| `--json` | One structured JSON object on stdout. |
| `-s, --simple` | Print only the number: `amountOut`, or `amountIn` under `--exact-out`. |
| `--nofee` | Zero the partner fee for this run. Refused in hosted mode (fee policy is server-side); use `--local`. |
| `--debug` | With `--simulate`: list ERC-20 transfers landing at `REFERRAL_ADDRESS`. |
| `--disableodosrfq`, `--odosnotcompact` | Odos workarounds (venue discontinued; kept for reference). |
| `--hosted` | Quote and build through the hosted API (`https://swap.9summits.io`) instead of the local engine, for this run. No venue key, no RPC (except `--simulate`). Nothing is signed remotely. Mutually exclusive with `--local`. |
| `--local` | Force the local engine for this run even when `SWAP_API_URL` is set. Uses your own venue keys and RPC. |

## 03 · Quoting

Default action: race every venue in parallel, print the winner (route tree, rate, gas, venue, router, tokens, bold summary). With `-v all` a live comparison block streams below, sorted by guaranteed `amountOut` (Fusion ranks on auction-end `minAmountOut`, shown next to the cote), `★` on the leader. When CoinGecko prices both legs the ranking is net of gas.

```sh
swap 1 WBTC ETH                                  # all venues
swap 1 WBTC ETH -v kyber                         # one venue
swap 1 WBTC ETH -v kyber,matcha,1inch            # subset
swap 1000 USDT USDC --chain bsc                  # another chain
swap 2 WETH stETH --all --allow-async            # include intent venues
swap 5000 USDC PEPE --slippage 1                 # wider tolerance
swap 1 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 USDC   # address instead of symbol
```

Venues whose API key is missing are skipped under `-v all` (stderr names the missing env vars); selecting one explicitly errors with the signup URL.

## 04 · Build & simulate

`-d` re-quotes with the real sender and prints an **approve tx** block (only when allowance is insufficient) and a **swap tx** block: target, calldata, value, gas. The approval target is the venue's *spender*, which can differ from the tx target.

```sh
swap 100 USDC USDT --from 0xYou -d                            # calldata + allowance check
swap max USDC WETH --from 0xYou -d                            # whole balance
swap 100 USDC USDT --from 0xYou --simulate                    # dry-run
swap 2000 WETH stETH -v all --from 0xYou --simu -d            # compare + simulate + calldata
swap 100 USDC USDT --from 0xYou --simulate --rpc http://127.0.0.1:8545   # local fork
```

`--simulate` appends a **simulation** block: gas used, revert reason, tokenOut actually received. Calldata stays hidden unless `-d` is also passed. Both need an RPC.

## 05 · Browser signing

`--browser` builds as for `-d`, starts a local server on `127.0.0.1:5151` and opens a RainbowKit page: quote summary, Connect Wallet (MetaMask, Rabby, WalletConnect…), a **simulate** button, and a hard block if the connected wallet is not `--from`. The tx hash or order id is reported back to the terminal.

```sh
swap 0.1 WETH USDC --from 0xYou --browser
swap 1 ETH WETH --from 0xYou --browser                          # wrap
swap 100 USDC -a send --to 0xRecip --from 0xYou --browser
swap 2 WETH stETH --allow-async --from 0xYou --browser          # sign an intent order
```

`swap` with no arguments opens the interactive dApp. In hosted mode (the default) this opens https://swap.9summits.io directly in your browser; pass `--local` to start the same dApp server on your machine instead, with your own keys. Set `NO_BROWSER_OPEN=1` to print the URL instead of opening a browser.

## 06 · Exact-out (buy)

`--exact-out`: `amount` is the tokenOut you want; venues are ranked by least tokenIn paid. Native buy paths: `velora`, `matcha`, `uniswap`, `cow`, `ophis`. Sell-only venues are refined as exact-in at the best native pay and must still deliver ≥ the target. A sell-only venue selected alone (`-v kyber --exact-out`) is rejected.

```sh
swap 1 USDC WBTC --exact-out                     # receive exactly 1 WBTC, pay as little USDC as possible
swap 1 USDC WBTC --exact-out --from 0xYou -d
swap 1 USDC WBTC --exact-out -s                  # just the USDC to pay
```

## 07 · Wrap, send & other actions

**Wrap / unwrap** — native ↔ wrapped pair (`ETH↔WETH`, `BNB↔WBNB`, `AVAX↔WAVAX`, `HYPE↔WHYPE`, `POL↔WPOL`, `XDAI↔WXDAI`) skips the venue loop: direct `deposit()` / `withdraw()` on WETH9, no approval.

```sh
swap 1 ETH WETH -d --from 0xYou
swap 1 WETH ETH -d --from 0xYou
swap 1 BNB WBNB --chain bsc -d --from 0xYou
```

**Send (`-a send`)** — plain transfer, no DEX. ERC-20 emits `transfer(to, amount)`; native emits a value-only tx. `tokenOut` ignored.

```sh
swap 100 USDC -a send --to 0xRecip --from 0xYou -d
swap 0.5 ETH  -a send --to 0xRecip --from 0xYou --browser
swap max USDC -a send --to treasury --from main          # wallet aliases
```

**Wallet aliases (`-a addwallet`)** — stored in `~/.swap/wallets.json`, usable in `--from` / `--to`.

```sh
swap -a addwallet main 0xYourAddress
swap 1 WBTC ETH --from main -d
```

**Protocol helpers**

| Action | Chain | Builds |
|--------|-------|--------|
| `-a unwrapwrseth` | Base | Kelp wrsETH → rsETH |
| `-a withdrawsparkweth` | Ethereum | Spark spWETH → WETH |
| `-a unstakesavax` | Avalanche | BENQI sAVAX → AVAX `requestUnlock` |
| `-a claimsavax` | Avalanche | Redeem matured sAVAX unlock requests (amount positional ignored) |

## 08 · Venues & chains

| Venue | Kind | Exact-out | Key |
|-------|------|-----------|-----|
| `kyber` | sync | refine | optional `KYBER_API_KEY` |
| `velora` | sync | native | — |
| `matcha` | sync | native | `ZEROEX_API_KEY` |
| `1inch` | sync | refine | `ONEINCH_API_KEY` |
| `curve` | sync | refine | — (needs RPC) |
| `uniswap` | sync | native | `UNISWAP_API_KEY` |
| `openocean` | sync | refine | optional `OPENOCEAN_API_KEY` |
| `cow` | intent | native | — |
| `ophis` | intent | native | `OPHIS_REFERRAL_CODE` |
| `delta` | intent | refine | — |
| `uniswapx` | intent | refine | `UNISWAP_API_KEY` |
| `fusion` | intent | refine | `ONEINCH_API_KEY` |
| `odos`, `odosv2` | disabled | — | API discontinued 2026-07-30 |

Sync venues return a broadcastable tx. Intent venues return an EIP-712 order you sign and POST off-chain; a solver settles it within the validity window. They require `--allow-async`.

### Availability by chain

Under `-v all` the CLI only races the venues that serve the selected chain; the others are skipped silently. Async venues still need `--allow-async`; `curve` needs an RPC. ✓ served, · not served. Snapshot of the adapters' chain tables; the live set for a deployment is `GET /api/mode`.

| Venue | eth | base | arb | op | unichain | bsc | avax | hype | robinhood | monad | plasma | polygon | gnosis | ink |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `kyber` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| `velora` (sync) | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | · | · | · | ✓ | ✓ | · |
| `matcha` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | ✓ | · | ✓ |
| `1inch` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| `curve` (sync) | ✓ | ✓ | ✓ | ✓ | · | · | ✓ | · | · | · | · | · | ✓ | · |
| `uniswap` (sync) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | ✓ | · | ✓ |
| `openocean` (sync) | ✓ | ✓ | ✓ | · | · | ✓ | ✓ | · | ✓ | · | · | ✓ | ✓ | · |
| `cow` (intent) | ✓ | ✓ | ✓ | · | · | · | · | · | · | · | · | ✓ | ✓ | ✓ |
| `ophis` (intent) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | ✓ | ✓ | ✓ | ✓ |
| `delta` (intent) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · | ✓ | · | · |
| `uniswapx` (intent) | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · | · | · | · | · | · |
| `fusion` (intent) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | ✓ | ✓ | · |
| *venues per chain* | 12 | 12 | 12 | 9 | 8 | 9 | 10 | 2 | 7 | 5 | 3 | 10 | 7 | 4 |

| Alias | Chain | Native |
|-------|-------|--------|
| `eth` | Ethereum (default) | ETH |
| `base` | Base | ETH |
| `arb` | Arbitrum One | ETH |
| `op` | Optimism | ETH |
| `unichain` | Unichain | ETH |
| `bsc` | BNB Chain | BNB |
| `avax` | Avalanche | AVAX |
| `hype` | HyperEVM | HYPE |
| `robinhood` | Robinhood Chain | ETH |
| `monad` | Monad | MON |
| `plasma` | Plasma | XPL |
| `polygon` | Polygon | POL |
| `gnosis` | Gnosis | XDAI |
| `ink` | Ink | ETH |

## 09 · RPC, keys & config

RPC is needed for `-d`, `--simulate`, `--browser`, `max`, the `curve` venue and unknown-token decimals. Resolution order, first match wins:

1. `--rpc <url>`
2. `RPC_URL_<chainId>` (e.g. `RPC_URL_1`)
3. `<ALIAS>_RPC_URL` (e.g. `ETH_RPC_URL`, `BASE_RPC_URL`)
4. `ALCHEMY_API_KEY` — one key covers every supported chain (free tier is enough)

The CLI has **no public RPC fallback**: missing config is a hard failure naming the exact variable to set. The interactive dApp server last-resorts to the shared PublicNode table when Alchemy and per-chain overrides are unset.

Config precedence: shell env → `.env` in the current directory → `~/.swap/config` (written by `--init`) → values embedded in the binary at build time. Prebuilt binaries ship venue keys and referral settings; your RPC key is always yours.

| Variable | Unlocks |
|----------|---------|
| `ZEROEX_API_KEY` | `matcha` (https://dashboard.0x.org) |
| `ONEINCH_API_KEY` | `1inch`, `fusion` (https://portal.1inch.dev) |
| `UNISWAP_API_KEY` | `uniswap`, `uniswapx` (https://hub.uniswap.org) |
| `KYBER_API_KEY` | `kyber` API gateway, higher rate limits (optional; from business@kyber.network). `KYBER_SOURCE` / `KYBER_REFERRAL` add on-chain attribution |
| `OPENOCEAN_API_KEY` | `openocean` pro host, higher limits (optional; public host is keyless, 2 rps) |
| `OPHIS_REFERRAL_CODE` | `ophis` (skipped without it) |
| `SENDER_ADDRESS` | default for `--from` |
| `WALLETCONNECT_PROJECT_ID` | WalletConnect in `--browser` (injected wallets work without it) |
| `REFERRAL_ADDRESS`, `REFERRAL_FEE_BPS` | partner fee attribution; `--nofee` zeroes it for one run |
| `NO_BROWSER_OPEN=1` | `--browser` / `swap` start the local server without launching a browser |

### Hosted mode

By default the public binary quotes and builds through `https://swap.9summits.io/api/*` instead of the local venue engine: no venue key and no RPC needed for a plain quote or a `-d` build, and every key-gated venue (1inch, Fusion, Matcha/0x, Uniswap, UniswapX) works out of the box. `--simulate` and the local-only actions (`send`, `unwrapwrseth`, `withdrawsparkweth`, `unstakesavax`, `claimsavax`) still run against your own RPC.

Resolution order: `--local` > `--hosted` > `SWAP_API_DISABLED=true` > `SWAP_API_URL` env var > local engine. The public prebuilt binary embeds `SWAP_API_URL=https://swap.9summits.io`. To self-host: pass `--local` for one run, set `SWAP_API_DISABLED=true`, or clear `SWAP_API_URL` (unset it in the shell, `.env`, or `~/.swap/config`), and configure your own venue keys and RPC.

| Variable | Default | Effect |
|----------|---------|--------|
| `SWAP_API_URL` | `https://swap.9summits.io` (embedded in the public binary) | Base URL of the `/api/*` deployment the CLI quotes and builds through. Empty/unset disables hosted mode |
| `SWAP_API_DISABLED` | `false` | `true` forces the local engine with your own keys and RPC even when `SWAP_API_URL` is set, so the embedded URL can be opted out of without clearing it. Accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`; any other value is an error |

Hosted specifics: `--nofee` is refused (fee policy is server-side); the offered venue list comes from `GET /api/mode` and omits `curve`; a `hosted  quotes and tx build via <base>` line marks every run on stderr; a rate-limited request (429) reports the retry delay; an unreachable API fails loud and suggests `--local` rather than falling back silently; a stale binary whose `apiVersion` no longer matches the deployment fails with `hosted API contract mismatch … run swap update`. No telemetry is added by hosted mode (the CLI still never calls `/done`), but the server does see the caller's IP, the pair, the amounts, and the `--from` address on a build, the same as the web dApp.

## 10 · Output & scripting

- **default** — route tree, rate / gas / venue / router rows, bold summary, live venue comparison under `-v all`.
- **`--json`** — one object. Multi-venue: `best` (venue name), `quotes` (object keyed by venue; each has `amountIn` / `amountOut` as `{raw, human, usd}`, optional `minAmountOut` for Fusion's auction floor, or `{error}`), `chain`, `tokenIn`, `tokenOut`, plus `approval`, `tx`, `order`, `permitTx`, `simulation` when built. Errors: `{"error": "…"}` and exit code 1.
- **`-s` / `--simple`** — just the human-units number: `amountOut`, or `amountIn` under `--exact-out`.

```sh
RATE=$(swap 1 WBTC ETH -s)
swap 1 WBTC ETH --all --json | jq -r '.best'
swap 1 WBTC ETH --all --json | jq '.quotes[.best]'
swap 100 USDC USDT --from 0xYou -d --json | jq -r '.tx.data'
swap 1000 USDC USDT --json | jq -r '.quotes | to_entries[] | select(.value.amountOut) | "\(.key)\t\(.value.amountOut.human)"' | sort -k2 -gr
```

Human-readable output goes to stdout; warnings and progress go to stderr, so `--json` and `-s` pipe cleanly.

## 11 · Unattended use (scripts, CI, agents)

- **Never prompts without a TTY.** The first-run RPC prompt is skipped when stdin or stderr is not a terminal; `--init` exits 1 instead of hanging. `--json` / `-s` also suppress it.
- **Exit codes:** `0` success, `1` any error (message on stderr; with `--json` also `{"error"}` on stdout).
- **Configure via env, not prompts:** `ALCHEMY_API_KEY` (or `RPC_URL_<chainId>`), `SENDER_ADDRESS`, venue keys as needed. A `.env` in the working directory is read too.
- **Set `NO_BROWSER_OPEN=1`** when starting `swap` / `--browser` on a headless machine; the URL is printed to stderr.
- **Local HTTP API:** `swap` (no args) serves the same stateless `/api/*` contract as the public host on `127.0.0.1:5151`, gated by `?id=<sid>` (printed at startup) or ungated with `SWAP_NO_AUTH=1`. Spec: https://swap.9summits.io/openapi.json
- **Public host limits:** per-IP token buckets per minute — quote-class 60, build 12, submit 6, everything else 120; HTTP 429 with `Retry-After` when drained. These calls spend the operator's venue keys: cache, and prefer the NDJSON stream.
- **Safety:** never coerce token decimals to 18; approve `tx.spender`, not `tx.to`; quote and build at the same slippage; a signed order must have been quoted with the real sender.

---
Disclaimer: https://swap.9summits.io/disclaimer.html · Contact: contact@9summits.io

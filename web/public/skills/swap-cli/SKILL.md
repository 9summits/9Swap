---
name: swap-cli
description: Get the best DEX swap quote on EVM chains (Ethereum, Base, Arbitrum, Optimism, BNB, Avalanche, HyperEVM, Unichain, Robinhood, Monad, Plasma, Polygon, Gnosis, Ink) across KyberSwap, Velora, 0x, 1inch, Curve, Uniswap, OpenOcean, CoW, UniswapX and more, and build the executable calldata, simulate it, or hand it to a wallet. Use when a user asks for a token swap price, the best route or venue, exact-out (how much do I pay to receive X), to wrap/unwrap ETH, to send a token, or to prepare a swap transaction from the terminal.
---

# swap — DEX meta-aggregator CLI

Single binary `swap`. Quotes need no configuration; building or simulating a tx needs an RPC key. Full manual: https://swap.9summits.io/docs.md · HTTP API: https://swap.9summits.io/openapi.json

## Install (once)

```sh
command -v swap >/dev/null || curl -fsSL https://swap.9summits.io/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

macOS / Linux, arm64 + x64. `swap update` upgrades in place.

## Configure through the environment, never through prompts

The CLI never blocks on stdin when it is not a TTY. Set what you need:

```sh
export ALCHEMY_API_KEY=…        # one key, every chain; needed for -d / --simulate / max / curve
export SENDER_ADDRESS=0x…       # default --from
# optional venue keys: ZEROEX_API_KEY (matcha), ONEINCH_API_KEY (1inch, fusion), UNISWAP_API_KEY (uniswap, uniswapx), KYBER_API_KEY (kyber gateway, higher limits), OPENOCEAN_API_KEY (openocean enterprise host)
```

Or `RPC_URL_<chainId>` (e.g. `RPC_URL_1`) for a specific RPC. Missing RPC config is a hard error that names the variable to set. The CLI has no public-RPC fallback (the hosted dApp last-resorts to PublicNode when Alchemy is unset).

## Core commands

```sh
swap <amount> <tokenIn> <tokenOut> [--chain eth|base|arb|op|avax|bsc|hype|unichain|robinhood|monad|plasma|polygon|gnosis|ink]
swap 1 WBTC ETH --json                      # every venue, ranked; machine output
swap 1 WBTC ETH -s                          # just the amountOut number
swap 1 WBTC ETH -v kyber,matcha             # subset of venues
swap 2 WETH stETH --all --allow-async       # include intent venues (CoW, UniswapX, Delta, Fusion)
swap 1 USDC WBTC --exact-out                # amount = tokenOut wanted; minimise USDC paid
swap 100 USDC USDT --from 0x… -d --json     # build: approval + tx calldata
swap 100 USDC USDT --from 0x… --simulate    # eth_simulateV1 dry-run: real tokenOut, revert reason
swap 1 ETH WETH --from 0x… -d               # wrap (direct WETH9 deposit, no venue)
swap 100 USDC -a send --to 0x… --from 0x… -d   # plain transfer, no DEX
swap 0.1 WETH USDC --from 0x… --browser     # hand to a human wallet via local RainbowKit page
```

Tokens: symbol (case-insensitive) or `0x` address. Amounts: human units; `max` = whole balance (needs `--from` + RPC). Slippage: `--slippage 0.5` (percent, default `0.1`).

## Reading `--json`

Multi-venue run: `best` is the winning venue name, `quotes` is an object keyed by venue; each entry has `amountIn` / `amountOut` as `{raw, human, usd}` or `{error}`. With `-d`: `approval` (`needed`, `tx`), `tx` (`to`, `data`, `value`, `gas`, `spender`), or `order` (EIP-712 `typedData` + `submit`), plus `simulation` with `--simulate`. Errors are `{"error": "…"}` with exit code 1.

```sh
swap 1 WBTC ETH --json | jq -r '.best'
swap 1 WBTC ETH --json | jq '.quotes[.best].amountOut.human'
swap 100 USDC USDT --from 0x… -d --json | jq '{spender: .tx.spender, to: .tx.to, approve: .approval.needed}'
```

## Rules that keep funds safe

1. **Approve `tx.spender`, not `tx.to`.** They differ on some venues (Velora).
2. **Never assume 18 decimals.** The CLI resolves real decimals; if it fails, it fails loudly. Do not work around it.
3. **Quote and build at the same slippage.** Otherwise the displayed route and the executed tx diverge.
4. **Intent venues (`--allow-async`) output an order to sign, not a tx.** Sign `order.typedData` with the real sender and POST to `order.submit.url`.
5. **Prefer `--simulate` before broadcasting** anything larger than dust; it reports the tokenOut actually received.
6. `--json` and `--browser` are mutually exclusive. Use `--browser` when a human must sign; use `-d --json` when you hold a signer.
7. The public host https://swap.9summits.io exposes the same `/api/*` endpoints (rate limited per IP: 60 quote-class, 12 build, 6 submit calls per minute). Use them for quotes when the binary is unavailable; they spend the operator's venue keys, so cache.

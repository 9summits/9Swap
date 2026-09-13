# Electric venue — install `erouter`

The `electric` venue shells out to Michael Egorov's
[electric-router](https://github.com/michwill/electric-router) CLI. Nothing from
that repo is vendored here (AGPL-3.0-or-later). Ethereum mainnet only; opt in
with `-v electric` or `-v curve,electric`. Not in `-v all`, not in the dApp.

The adapter looks for `~/git/electric-router/.venv/bin/erouter` if
`EROUTER_BIN` / `PATH` are unset.

## Prereqs

- Python ≥ 3.11
- [uv](https://docs.astral.sh/uv/)
- git-lfs (state caches are LFS objects; without it every quote is cold)

```sh
brew install git-lfs
git lfs install
```

## Install

```sh
git clone https://github.com/michwill/electric-router.git ~/git/electric-router
cd ~/git/electric-router
git lfs pull
uv sync --group dev
.venv/bin/erouter --help
```

`uv sync` does **not** install `erouter_evm`. Without that extension a local
warm exits 4, so this repo passes `--no-local` (RPC for every probe). Quotes
work; they are slower and not identical to the in-process EVM path.

## Optional: local EVM

Needs rustup + maturin. From the electric-router checkout:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
uv tool install maturin
uv pip install --reinstall --no-deps ./rust
uv pip install --reinstall --no-deps ./rust/evm
```

Then:

```sh
EROUTER_LOCAL=1 bun run src/index.ts 10000 usdc weth -v electric
```

## Run

Same RPC as the rest of the CLI (`--rpc`, `RPC_URL_1`, `ETH_RPC_URL`, or
`ALCHEMY_API_KEY`).

```sh
bun run src/index.ts 10000 usdc weth -v curve,electric
```

Checkout not at `~/git/electric-router`:

```sh
export EROUTER_BIN=/path/to/electric-router/.venv/bin/erouter
export EROUTER_CWD=/path/to/electric-router
bun run src/index.ts 10000 usdc weth -v electric
```

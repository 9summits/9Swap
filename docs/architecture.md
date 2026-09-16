# Architecture

Internals of the `swap` CLI: layout, the `NormalizedQuote` contract, the quote →
pick → build pipeline, output modes, transaction build, RPC/allowance handling,
token resolution, chains, the short-circuit actions, gas-USD fallback, and
simulation. Venue-adapter specifics live in [venues.md](./venues.md); the
interactive dApp and browser flow in [dapp.md](./dapp.md); cross-cutting rules in
[conventions.md](./conventions.md).

## Synopsis

```
swap <amount> <tokenIn> [tokenOut] [-a swap|send] [--to <addr>] [--chain <alias>] [--venue <name>] [--exact-out] [--allow-async] [--simulate] [--json | --simple]
swap update                 # replace the installed binary with the latest public prebuilt (no-op when already current)
```

`tokenIn` and `tokenOut` accept either a symbol (`WBTC`) or a `0x` address.
`tokenOut` is required for `-a swap` (the default) and ignored for `-a send`. By
default `<amount>` is **tokenIn** (exact-in / sell). With `--exact-out` it is
**tokenOut** (exact-out / buy) — see [venues.md](./venues.md#exact-out).

## Layout

```
src/
  index.ts          entry point; commander wiring, orchestration
  chains.ts         chain alias table (eth/arc/arb/base/op/bsc/avax/hype/unichain/robinhood/monad/plasma/polygon/gnosis/ink) — chainId, kyberPath, coingeckoPlatform, explorer, wrappedNative
  tokens.ts         symbol/address → Token resolution (KyberSwap ks-setting → CoinGecko fallback)
  amount.ts         bigint base-unit conversion + USD formatting
  trade_side.ts     TradeSide sell|buy, BUY_CAPABLE_VENUES, amountIn XOR amountOut parsers
  slippage.ts       minAmountOut / maxAmountIn (shared by allowance ceilings + cow/ophis signed amounts)
  format.ts         terminal renderer (route tree, rate rows, summary, venue comparison)
  json.ts           structured JSON payload shaper (shared label helper with format.ts)
  wrap.ts           native ↔ wrapped-native short-circuit (synthQuote, buildWrapTx, detectWrap)
  send.ts           -a send action — synth quote + ERC20 transfer / native value tx (synthSendQuote, buildSendTx)
  unstake_savax.ts  -a unstakesavax — BENQI sAVAX requestUnlock; exports SAVAX_AVAX + getPooledAvaxByShares
  claim_savax.ts    -a claimsavax — BENQI sAVAX redeem() of matured unlocks; discoverClaimableSavax reads/classifies queued requests
  gas_usd.ts        post-fetch USD-fill for venues whose API doesn't return one (matcha, 1inch, curve heuristic)
  version.ts        `swap --version`: CLI_VERSION (package.json), resolveBuildInfo (BUILD_INFO, else git in dev), formatVersion
  build_info.ts     build commit sha + UTC date; null in source, regenerated at build time by scripts/build-info.ts and restored right after
  venues/
    types.ts        NormalizedQuote / NormalizedTx / NormalizedOrder / NormalizedPermitTx shapes, Venue union, VENUES/VENUE_OPTIONS
    index.ts        dispatcher: fetchQuote(venue,…), fetchAllQuotes, pickBest, build, assemblePermitTx
    kyber.ts        KyberSwap aggregator-api adapter
    odos.ts         Odos /sor/quote/v3 adapter (pathViz for route tree + symbol hints)
    odosv2.ts       Odos legacy /sor/quote/v2 adapter
    velora.ts       Velora (ex-Paraswap) /prices adapter
    matcha.ts       0x (Matcha) /swap/permit2/price adapter — needs ZEROEX_API_KEY
    oneinch.ts      1inch /swap/v6.0/{chainId}/quote adapter — needs ONEINCH_API_KEY
    cow.ts          CoW Protocol (intent/batch auction) — async, requires --allow-async
    delta.ts        Velora Delta (intent auction) — async, keyless, SELL-only
    uniswapx.ts     UniswapX Dutch orders — async, needs UNISWAP_API_KEY
    fusion.ts       1inch Fusion (Dutch auction) — async, reuses ONEINCH_API_KEY
    curve.ts        Curve Finance — on-chain (curve-js); quote returns null gas
    uniswap.ts      Uniswap classic (v2/v3/v4) — Trading API + SwapRouter02/V2Router02 fast path + Path A
  simulate.ts       --simulate impl: state-override RPC prank → approve + swap via eth_simulateV1
  browser.ts        --browser impl: Bun.serve() local UI bridge; /tx, /assemble, /simulate, /submit, /done
  browser.embedded.ts  text-imports web/dist/index.html (vite singlefile) at build time
  core.ts           commander-free composition layer over the primitives (shared by the server handlers)
  remote.ts         hosted mode (`--hosted` / `--local` / `SWAP_API_URL` / `SWAP_API_DISABLED`): `/api/*` client that replaces the local venue engine for quote + build, and the wire → NormalizedQuote mapping
  server/
    handlers.ts     STATELESS request handlers for every dApp endpoint (Web Fetch API only, no Bun.*)
    shared.ts       Bun-free helpers extracted out of browser.ts (Payload types, rewriteAuthedOrderSubmit, proxyOrderSubmit)
  serve.ts          `swap` (no args) interactive dApp server: thin long-lived Bun.serve shell
  update.ts         `swap update` — compare the installed binary's SHA-256 with the published `.sha256` manifest, then download the latest Blob prebuilt and atomically replace it only when they differ
api/                Vercel serverless functions (one thin file per route) delegating to src/server/handlers.ts
vercel.json         install/build/output config + rewrites
web/                Vite + React + RainbowKit source for the dApp (separate package)
shared/rank.ts      venue ranking (gross or net-of-gas). CLI, API, and dApp import this.
```

Bun is required (both at dev time and to compile the binary). Native `fetch` is
used throughout — `axios` appears in `package.json` only because
`@1inch/fusion-sdk`'s module graph statically imports its optional axios
connector; we never call it (fusion gets a fetch-backed `httpProvider`).

## `NormalizedQuote` — the venue-agnostic contract

`NormalizedQuote` is the contract every venue adapter must produce.
`format.ts` and `json.ts` consume only this shape, so the renderers stay
venue-agnostic. Adapters flatten whatever path/route representation the upstream
API uses into a single `hops[]` list, with `tokenIn` / `tokenOut` / `swapAmount`
set consistently in the input token's base units — `format.ts` groups by
`hop.tokenIn` to render the "split on X" tree. The full adapter responsibilities
are in [venues.md](./venues.md#venue-adapter-contract).

## Quote → pick → build pipeline

1. **Quote** — `fetchAllQuotes` runs every selected adapter in parallel via
   `Promise.allSettled` and returns a `VenueResult[]`.
2. **Pick** — `pickBest(results, side, rank)` selects by side: sell → highest
   variable-leg key (`minAmountOut` when a venue exposes a guaranteed floor,
   else `amountOut`); buy → lowest, then highest gross `amountOut` on ties.
   When a USD price is available for the variable-leg token and the native gas
   token (CoinGecko, else DefiLlama), `rank` is net-of-gas (token units after a
   gas haircut). Otherwise it stays gross. The public `/api/quote` path always
   passes gross (no price oracle on the serverless). Displayed amounts stay
   gross; only order and ★ change.
3. **Build** — with `-d`, the winner's venue is called a second time to assemble
   an executable transaction (see [Tx build](#tx-build--d--data)).

## Hosted mode

`src/remote.ts` is the `--hosted` / `--local` client: when it resolves a
non-null API base, `-a swap` runs against that deployment's `/api/*` instead
of the local venue engine. `resolveApiBase()` precedence: `--local` beats
`--hosted` (`HOSTED_DEFAULT = https://swap.9summits.io`) beats
`SWAP_API_DISABLED=true` beats the `SWAP_API_URL` env var (both read after
`loadDotenv()`, so a value baked into `.env.install` wins for the public
binary unless a shell export overrides it) beats the local engine.

`SWAP_API_DISABLED` (default `false`) is the explicit opt-out: unsetting an
embedded `SWAP_API_URL` is awkward, so `SWAP_API_DISABLED=true` forces the
local engine and its own keys without touching the URL. It accepts
`1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off` (case-insensitive, trimmed);
any other value throws `SWAP_API_DISABLED must be true or false (got "…")`
rather than degrading to `false`, since a silent `false` would leave the run
hosted — the exact outcome the user was opting out of. The CLI flags always
win over both variables.

What moves to the API in hosted mode: `remoteResolveToken` /
`remoteResolveAddresses` replace `resolveToken` / `resolveAddresses`
(`POST /api/resolve-token`); `remoteMode()` hits `GET /api/mode` once per
run, checks `apiVersion` against the CLI's own `API_VERSION`
(`src/server/shared.ts`) and throws "hosted API contract mismatch … run
`swap update`" on any mismatch, then supplies the venue/chain list used in
place of the local adapter tables; `remoteQuoteStream` (`POST
/api/quote/stream`, NDJSON) and `remoteQuoteAll` (`POST /api/quote`) replace
`fetchAllQuotesStream` / `fetchAllQuotes`, yielding the same `VenueResult[]`
the renderers already consume; `remoteBuild` (`POST /api/build`) replaces
`build()`, and its `approval` field replaces the local allowance `eth_call`
so `-d` needs no RPC either. The Permit2 second leg (`remoteAssemble`,
`POST /assemble`) and async-order submit URLs (`remoteSubmitUrl`) are
rewritten the same way for `--browser`, whose local bridge proxies
`/assemble` and `/submit` to the hosted base instead of handling them
itself (see [dapp.md](./dapp.md)).

What stays local even when hosted: `--simulate` (`eth_simulateV1` always
runs against the caller's own RPC) and the actions that build their own
calldata and read the chain directly (`-a send`, `unwrapwrseth`,
`withdrawsparkweth`, `unstakesavax`, `claimsavax`; see
[Actions & short-circuits](#actions--short-circuits)). `resolveApiBase()`
only gates `-a swap`; the orchestrator in `src/index.ts` sets a
`hostedLocalActionNote` for the other actions so a resulting
`RpcConfigError` explains why an RPC is still being asked for.

The wire to `NormalizedQuote` mapping lives in `routeQuoteToNormalized`
(`src/remote.ts`): it tolerates a deployment that predates the
`hops`/`router`/`protocolFee`/`tokenHints` wire additions (empty route
tree, `router: null`, rather than crashing), never trusts a wire `decimals`
it cannot validate (`assertDecimals`, range `[0, 36]`, see
[conventions.md](./conventions.md#decimals-are-safety-critical)), and
rebuilds the `buyRefine` object client-side from data the CLI already holds
(the wire only carries a boolean) instead of trusting anything sent back.
`venueResultsFromNdjson` decodes the streaming response into the same
`VenueResult` events as the local `fetchAllQuotesStream`, including a route
split across two network chunks.

The CLI never signs in hosted mode, same as local: it only renders what the
API returns. `--nofee` is refused when hosted (fee policy is server-side);
a hosted run is otherwise indistinguishable in output from a local one.
`swap --show-mode` is the way to tell them apart: handled in the
pre-commander block right after `loadDotenv()` (so it needs no positional and
sees a build-embedded `SWAP_API_URL`), it resolves the same
`resolveApiBase({hosted, local})` and prints `describeMode`'s single line —
`hosted <base>` or `self-hosted` — on stdout, then exits 0. It is also
declared as a commander option so it shows in `--help`. Offline coverage
lives in `tests/hosted_mode.test.ts`: it stubs
`fetch` and exercises base resolution, the wire mapping, the NDJSON reader
(split chunk boundaries included), and the 429 / network / contract-mismatch
error paths.

## Output modes

- **Default (terminal)** — route tree (grouped by input token, showing % splits)
  → rate/gas/chain/venue/router/tokens rows → bold summary line with
  amounts/USD/price impact. With `-v all`, a `venues` comparison block is
  appended below the summary; async venues are tagged `(intent)` with a
  footnote. With `-d`, a `tx` block (sync venue) or an `order` block (async
  venue) is inserted between the summary and the comparison.
- **`--json`** — structured object. For a single venue, the canonical quote
  shape. For `-v all`: `{venue: "all", best, chain, tokenIn, tokenOut, quotes:
  {<venue>: <quote|{error}>}}`. With `-d`, adds top-level `kind: "tx" | "order" |
  "permit-tx" | null` and the corresponding payload — exactly one of `tx` /
  `order` / `permitTx` is non-null. Errors emit `{"error": "..."}` with exit 1.
- **`--simple` / `-s`** — prints only the numeric variable leg for shell piping:
  `amountOut` by default, or `amountIn` with `--exact-out`. Skips the
  intermediary-token lookup to save a network call.

`--json` and `--simple` are mutually exclusive. `--simple` and `--data` are
mutually exclusive.

## Actions & short-circuits

`-a swap` (default) runs the full venue-comparison + tx-build pipeline. The other
actions short-circuit the venue loop entirely: each synthesizes a
`NormalizedQuote` (with a pseudo-venue label) and a `NormalizedTx`, then reuses
the standard render / `-d` / `--browser` pipeline.

- **`-a send`** (`src/send.ts`) — direct token transfer. ERC20 emits a standard
  `transfer(to, amount)` (`0xa9059cbb`); native emits a value-only tx
  (`to=recipient, value=amount, data="0x"`). Requires `--to <addr>`. No
  allowance check (transfer operates on the sender's own balance; native send
  carries the value via `msg.value`). Venue label `"send"`, hop labelled
  `transfer to <recipient>`.
- **Native ↔ wrapped-native** (`src/wrap.ts`) — see
  [below](#native--wrapped-native-short-circuit).
- **`-a unstakesavax`** (`src/unstake_savax.ts`) — Avalanche-only. Initiates a
  BENQI sAVAX unlock: `requestUnlock(uint256 shareAmount)` (`0xc9d2ff9d`) queues
  the shares for redemption (15-day cooldown). `<amount>` is the sAVAX amount
  (`max` reads balance); amountOut is the live AVAX value via
  `getPooledAvaxByShares` (`0x4a36d6c1`). No allowance check — the debit pulls
  from `msg.sender`'s own balance.
- **`-a claimsavax`** (`src/claim_savax.ts`) — Avalanche-only, the second leg of
  the sAVAX unstake. After the cooldown each unlock request opens a ~2-day redeem
  window; `redeem()` (`0xbe040fb0`, no args) redeems **every** request currently
  inside its window and skips those still in cooldown (never reverts on
  ineligible ones). The `<amount>` positional is an ignored placeholder — what's
  claimed is whatever is matured on-chain. `discoverClaimableSavax` (needs
  `--from` + an RPC) reads the user's requests via `getUnlockRequestCount` /
  `userUnlockRequests` and classifies each against `cooldownPeriod` /
  `redeemPeriod` + the latest block timestamp into claimable / pending (ETA) /
  overdue, printing a per-request status summary to stderr (gated off
  `--json`/`--simple`). Output is native AVAX — there is no atomic WAVAX path, so
  wrap afterward with `swap <amt> AVAX WAVAX --chain avax`. Requests past the
  redeem window are "overdue" and need the contract's `redeemOverdueShares`
  (returns sAVAX, not AVAX) — out of scope here.

## Tx build (`-d` / `--data`)

When `-d` is set, after the quote the winner's venue is called a second time to
assemble an executable transaction: `to`, `from`, `data` (calldata), `value`,
`gas`, `gasPrice`, `chainId`. Every adapter exposes a `buildTx(params)` function
and the dispatcher in `src/venues/index.ts` routes based on the chosen venue.
Per-venue build specifics (endpoints, spenders, Path A, etc.) are in
[venues.md](./venues.md).

**Sender address** resolution (highest priority first):

1. `--from <addr>` CLI flag
2. `SENDER_ADDRESS` env var (from `.env` or shell)

There is no placeholder default. `-d` and `amount=max` both hard-fail if neither
source is set — the sender is embedded in the build calldata as the swap
**output recipient**, so silently defaulting to anything (even an obvious burn
address) risks a user signing a tx that sends tokens to an unrecoverable address.
Whatever is chosen is normalized to its EIP-55 checksum via `src/checksum.ts`
(uses `@noble/hashes` keccak-256) — Velora rejects non-checksummed addresses, so
this is non-negotiable.

**Slippage** defaults to 10 bps (0.1%), override with `--slippage <pct>`
(percent, e.g. `0.5` = 50 bps). Each adapter translates to whatever unit its API
expects (percent, bps, basis-point multiplier). The user's slippage is used for
**both** the quote and the build — Odos in particular lets slippage steer the
route search, so evaluating the quote at a different slippage than the build
would cause the displayed route / `amountOut` to diverge from what the tx
actually executes. `src/slippage.ts` is the single source for the min-out /
max-in floors used by allowance ceilings and cow/ophis signed order amounts.

`BuildResult = ({kind:"tx"} & NormalizedTx) | NormalizedOrder |
NormalizedPermitTx` is the discriminated union returned by the `build(venue,
params)` dispatcher. All three kinds expose `spender`, so the allowance check
works for all without branching. The `kind` discriminator forces narrowing at
every consumption site (terminal renderer, JSON wrapper, browser payload) — the
union is intentionally not collapsible. See
[venues.md](./venues.md#permit-tx-buildresult-kind) for the `permit-tx` kind.

## Allowance check & priority fee

When `-d` is set **and** `tokenIn` is an ERC20 (not the native sentinel), `swap`
performs an `eth_call` to the token's `allowance(owner, spender)` and compares
against the required amount:

- **Sufficient** → green `✓ allowance ok` line.
- **Insufficient** → yellow `! approval needed` block with a ready-to-send
  `approve(spender, amountIn)` tx: target = tokenIn, selector `0x095ea7b3`,
  padded spender + exact amountIn.

The approve tx uses exact `amountIn` (not infinite) for safety and
minimum-trust reasoning. Users wanting infinite approval can call
`approve(spender, uint256.max)` themselves.

**Skipped when the router is paid natively** — `inputPaidViaValue(chain,
tokenInAddress, build)` in `src/core.ts` returns true when the chain has a
`nativeErc20`, the input IS that token, the build is a sync `tx` and its
`value > 0`. That's Uniswap's Arc route: `value = amountIn × 10^12` and the v4
`SETTLE` pays from the router's own balance (`payerIsUser=false`), so an
approval would be a pointless second transaction. Both the CLI (`src/index.ts`)
and the dApp's `/api/build` (`src/server/handlers.ts`, `approval: null`) skip
the allowance read in that case. The predicate is deliberately narrow and
fail-safe in the right direction: a hypothetical build that set a value *and*
pulled via Permit2 would revert (gas lost, nothing over-spent), whereas a
needless approval leaves standing spend authority behind.

Also fetched via `eth_maxPriorityFeePerGas`: `maxPriorityFeePerGas` is surfaced
on the swap tx and the approve tx as a separate `priorityFee` row. Together with
the aggregator's `gasPrice`, users can construct a proper EIP-1559 transaction.

## RPC URL resolution

Highest priority first:

1. `--rpc <url>` CLI flag — per-invocation override; URL-validated up front;
   installed via `setRpcOverride` in `src/rpc.ts` before any RPC consumer runs
   (covers venue/curve init, `--simulate`, allowance / priority-fee reads, gas
   USD oracle, etc.).
2. `RPC_URL_<chainId>` env var (e.g. `RPC_URL_1`).
3. `<ALIAS>_RPC_URL` env var (e.g. `ETH_RPC_URL`, `HYPE_RPC_URL`).
4. `ALCHEMY_API_KEY` + the chain's `alchemySubdomain` (from `src/chains.ts`) →
   `https://{subdomain}.g.alchemy.com/v2/{key}`. One Alchemy key covers every
   supported chain.
5. dApp server only: `CORS_OPEN_RPC[chainId]` from `shared/public_rpc.ts`
   (PublicNode, plus a few chain-native CORS-open endpoints). Enabled by
   `setPublicRpcFallback(true)` in `src/server/handlers.ts`. The CLI never
   takes this step.

The CLI has **no public RPC fallbacks**. See
[conventions.md](./conventions.md#no-public-rpc-fallbacks) for the rationale and
the runtime-error handling policy.

## Spender field

`NormalizedTx.spender` is a separate field from `tx.to` precisely because Velora
diverges (its spender is `priceRoute.tokenTransferProxy`, not the Augustus
router). For every other venue `spender === tx.to`. Code that reasons about "what
address needs the ERC20 approval" should always read `tx.spender`, never assume
it equals `tx.to`.

## Token resolution

`resolveToken(input, chain)` in `src/tokens.ts`:

1. If `input` matches `/^0x[a-fA-F0-9]{40}$/` → address path (`resolveByAddress`):
   try KyberSwap first, then CoinGecko `/coins/{platform}/contract/{addr}`. If
   both miss, fall back to an on-chain `decimals()` call and return `{symbol:
   "0x…abcd", name: "unknown token", source: "onchain"}` with the authoritative
   decimals. If that also fails (RPC not configured or call reverts), the command
   hard-fails — **never** returns a guessed decimals.
2. If `input` is the chain's native symbol (e.g. `ETH` on eth/arb/base) → returns
   the `0xeee…eee` sentinel synthetic token.
3. Otherwise (symbol): sequential fallback chain
   - KyberSwap `ks-setting.kyberswap.com/api/v1/tokens?isWhitelisted=true` —
     exact-symbol match
   - CoinGecko `/search?query=` → filter by exact symbol → walk the first 8
     candidates **sequentially**, calling `/coins/{id}` and stopping at the
     first one whose `platforms[chain.coingeckoPlatform]` is set (a parallel
     burst trips the free tier's rate limit reliably)
4. Ambiguity short-circuits the fallback chain: if KyberSwap returns >1 exact
   match, we throw candidates (don't fall through) — the user is expected to
   disambiguate with an address.

**Decimals are safety-critical** (see
[conventions.md](./conventions.md#decimals-are-safety-critical)).
`resolveDecimals(chain, address, offChainDecimals)` prefers the off-chain value
when present; otherwise it reads `decimals()` on-chain (selector `0x313ce567`,
bounded to `[0, 36]`). If neither source yields a value the command fails with a
message pointing at `ALCHEMY_API_KEY` / `<ALIAS>_RPC_URL`. The CoinGecko branches
(both symbol and address) use `decimal_place` only when it is actually a number —
never coerce `null` to `18`.

**CoinGecko rate limits (HTTP 429)** are bounded, never open-ended. Every
CoinGecko call in `tokens.ts` carries a 10s `AbortSignal.timeout` and gets **one**
retry, waiting `Retry-After` (numeric seconds or HTTP-date) capped at 5s — 2s when
the header is absent or garbage — logged to stderr before it sleeps. If that retry
is still 429 the call throws the typed `CoinGeckoRateLimitError` and arms a
module-level cooldown (`max(Retry-After, 60s)`, capped at 5 min) during which every
further CoinGecko call fails fast **without** issuing a request. Consequences:

- the `/coins/{id}` candidate loop aborts on the first `CoinGeckoRateLimitError`
  instead of hammering the API 8 times; other per-candidate errors still log and
  continue;
- the symbol path surfaces `coingecko: rate limited (HTTP 429) …` in the final
  error (headline says "a lookup source is rate limiting", not a misleading
  "not found");
- the address path treats it like any other CoinGecko miss: log, then fall
  through to the authoritative on-chain `decimals()`;
- the second token of a pair, a warm serverless instance and the long-lived dApp
  server all skip CoinGecko for the cooldown window instead of each paying the
  retry wait again.

Worst case per call is therefore ~2 requests + ≤5s, which fits the serverless
budget (`api/resolve-token.ts` also declares `maxDuration = 60`, like the other
entry points).

USD *prices* (CLI net-of-gas ranking and the dApp mid, `web/src/dapp/cgPrices.ts`)
treat CoinGecko as best-effort, not a blocker. Each call has a 4s
`AbortSignal.timeout`. A 429 / 5xx / timeout / network error arms the same
cooldown as token resolution **without** a Retry-After sleep — sleeping used to
freeze the CLI mid-quote and a second CoinGecko hit during a storm never helped.
The same tokens are then asked of keyless DefiLlama
(`coins.llama.fi/prices/current`, `coingecko:{id}` or `{chain}:{address}`).
A successful DefiLlama fill is silent (a recovered fallback must not punch a
line through the live venue table). Only a total miss logs one compact stderr
line (never an `Error` object — that dumps a stack per token of the batch),
then the ≤10 min stale-on-error cache.

`resolveAddresses(addrs, chain)` batches intermediary-token lookups via
ks-setting's `addresses=a,b,c` parameter. Called once per quote (except in
`--simple` mode) so hops render with real symbols instead of `0x1234…abcd`.

**Why DeFiLlama is not in the token-resolution fallback chain**: their public
API has no symbol→address search (`coins.llama.fi/search` returns `"This
endpoint doesn't exist"`). Address-keyed *price* lookups do exist, and that is
the CoinGecko fallback for USD prices above.

## Chains

Defined in `src/chains.ts`. Adding a chain means adding a `ChainInfo` with:

- `chainId` (EVM chain id)
- `kyberPath` — KyberSwap's URL path segment (e.g. `ethereum`, `arbitrum`,
  `hyperevm`). Nullable: `null` means KyberSwap is not available on that chain
  and the kyber adapter throws `UnsupportedChainError`. Currently `null` on
  Gnosis and Ink.
- `coingeckoPlatform` — the key CoinGecko uses in `platforms` /
  `detail_platforms` (e.g. `arbitrum-one`, `hyperevm`)
- `nativeSymbol` (`ETH`, `AVAX`, `HYPE`, `USDC`, …) and `explorer`
  (etherscan-style base URL)
- `wrappedNative` — canonical WETH9-equivalent for the chain. Used by the
  wrap/unwrap short-circuit. Nullable: `null` means the chain has no WETH9-style
  wrapper and the short-circuit never fires there. Currently `null` on Arc.
- `nativeErc20` — set only when the chain's gas token is itself an ERC20.
  `null` everywhere except Arc.

Each venue adapter has its own chainId whitelist; add the new chain id there if
the venue supports it.

### Arc's native model (`nativeErc20`)

Arc (5042) pays gas in USDC, and the same balance is visible two ways: **18
decimals** at the EVM level (`msg.value`, `eth_getBalance`, gas accounting) and
**6 decimals** through an ERC20 interface at `0x3600…0000`. Circle's docs say to
use the ERC20 view, and only that view produces correct calldata — the other is
off by 10^12. There is also no WETH9-style wrapper for it (the bridged `WETH` at
`0x128cC466…84EDB` is bridged ETH, not a wrapper of the native asset).

So on a chain with `nativeErc20` set:

- the native symbol (`USDC` on Arc) resolves to that ERC20, with the builtin
  table's on-chain-verified decimals;
- the curated token list does **not** prepend the synthetic `0xeee…` entry — the
  builtin table leads instead;
- passing `0xeee…` explicitly is a hard error naming the ERC20 address, rather
  than a silently mis-scaled quote;
- `wrappedNative` is `null`, so wrap/unwrap is disabled (see below).

Gnosis, Ink and Arc have their curated lists in `src/tokens_builtin.ts` — the
same fallback used for Robinhood. Gnosis and Ink have no KyberSwap ks-setting
token list at all (0 tokens); Arc is indexed but its whitelist is mostly
memecoins and omits the majors, and its USDC entry needs a trusted 6-decimals
value.

## Native ↔ wrapped-native short-circuit

When `tokenIn` and `tokenOut` form the native↔wrapped pair (`ETH ↔ WETH`, `AVAX
↔ WAVAX`, `HYPE ↔ WHYPE`, …), `swap` skips the venue-quote loop entirely — the
rate is 1:1 by construction, no aggregator can offer better, and routing through
Universal Router / Augustus / etc. just adds gas. Detection lives in
`src/wrap.ts`'s `detectWrap()`, called from the orchestrator right after token
resolution. When matched:

- Synthetic `NormalizedQuote` with `venue: "wrap"` (a pseudo-venue label — not in
  the `Venue` union's iterables, never reaches the dispatcher), `amountOut ==
  amountIn`, and a single hop labelled `ETH → WETH (deposit)` / `WETH → ETH
  (withdraw)`.
- `-d` builds the tx directly via `buildWrapTx`: wrap → `deposit()` (`0xd0e30db0`)
  on WETH9 with `value = amountIn`; unwrap → `withdraw(uint256)` (`0x2e1a7d4b` +
  32-byte amount) with `value = 0`.
- No ERC20 allowance check fires in either direction. Wrap has native input
  (already skipped). Unwrap has WETH input but `withdraw()` operates on
  `msg.sender`'s own balance — no `transferFrom`, no allowance needed.
- `-v all` / `-v <list>` are ignored when the pair triggers wrap mode; the
  comparison block is suppressed. `wrap` is never user-selectable — only
  auto-applied.

Chains with `wrappedNative: null` have no wrap/unwrap at all: `detectWrap()`
returns `null` immediately, so every pair goes through the venue loop. Arc is
the case — its native USDC has no WETH9-style wrapper, and the bridged `WETH`
that exists there is bridged ETH, not a wrapper of the gas token.

The pseudo-venue cast (`"wrap" as Venue` in `synthQuote`) is the only place we
widen the type. Renderers and JSON output treat `quote.venue` as a string label,
so the cast is harmless at runtime.

## Gas USD fallback (`src/gas_usd.ts`)

Some venues' APIs don't return a USD value for gas: matcha (no field), 1inch (gas
units only, no price/USD), curve (no quote-time gas at all). The renderer keys on
`quote.gasUsd`, so those rows would otherwise show `gas —` in the comparison
block. `fillGasUsd(quote, chain)` (and `fillGasUsdAll` for `-v all`) runs after
the venue fetch loop and back-fills the missing value:

```
gasUsd = gasUnits × gasPriceWei × ETH_USD / 1e18
```

with `ETH_USD = 2000` hardcoded (relative ranking is what matters in the
comparison block; absolute USD doesn't need cent-precision). `gasPriceWei` comes
from the venue's quote response when present, otherwise from `eth_gasPrice` on
the chain's RPC — the per-chain call is memoized so it fires at most once per CLI
invocation.

Curve gets a special branch: `estimateCurveGasUnits(hops)` synthesizes `gasUnits`
from the route shape (150k per stableswap-flavoured hop / 220k per cryptoswap
hop, +50k once for multi-hop RouterNG overhead) since curve-js doesn't expose a
quote-time gas estimate. ±20% accuracy — for comparison-block ordering, not bid
construction.

Skipped when (a) the chain's native isn't ETH (BNB / AVAX / HYPE — no point
hardcoding their prices for a comparison-only display) or (b) `gasUnits` is
missing and not derivable. Arc is the exception among non-ETH natives: it pays
gas in USDC, so `nativeUsdFor` returns 1 by construction, no hardcoded spot.

## Simulation (`--simulate` / `--simu`)

Sync-venue only. After building the swap tx (auto-implies `-d`), the CLI runs
`simulateSwap` in `src/simulate.ts`:

1. **Prank tokenIn balance.** For ERC20 input, find the `_balances[sender]`
   storage slot via parallel write-probe (32 candidate slots × `eth_call` with a
   sentinel state override; the slot whose `balanceOf(sender)` returns the
   sentinel is the one). For native input, override `sender.balance` directly.
   Either way the chain isn't touched — overrides only live inside the simulation.
   On a chain whose gas token IS an ERC20 (`chain.nativeErc20`, i.e. Arc's USDC
   at `0x3600…0000`) there is no balances slot to probe — the token's balance is
   the account's native balance. `simulateSwap` takes `nativeErc20` and funds
   that input through `sender.balance` instead, scaling the ERC20 amount up by
   `10^(18 - decimals)` (10^12 on Arc) to reach the 18-decimal EVM-level view.
   The approve call stays in the batch: kyber / 1inch / openocean still pull
   Arc USDC via `transferFrom`.
2. **Run approve + swap in one `eth_simulateV1` block.** Both calls share state,
   so the approve sets the allowance the swap consumes. Native input skips the
   approve.
3. **Read pre/post tokenOut balance** in the same batch. ERC20 output →
   `balanceOf(sender)` on the token; native output →
   `Multicall3.getEthBalance(sender)` (Multicall3 is at
   `0xcA11bde05977b3631167028862bE2a173976CA11` on every supported chain). The
   diff is what the user actually receives.
4. **Surface the result** as a `simulation` block (terminal) or `simulation`
   field (JSON):
   - `approve.status` (ok / reverted / skipped) + `gasUsed`
   - `swap.status` + `gasUsed` + `revertReason` (decoded `Error(string)`,
     `Panic(uint256)`, a known custom-error selector — currently
     `SafeTransferFromFailed`, `ReturnAmountIsNotEnough`, `AccessDenied`,
     `InvalidMsgValue` — or the raw 4-byte hex for unknowns; extend the table in
     `parseRevertReason` as needed)
   - `tokenOutReceived` and the delta vs the quoted amountOut

**1inch / PMM hint** — when `venue === "1inch"` and the swap reverts with
`SafeTransferFromFailed` *or* a generic "execution reverted" with no return data,
the orchestrator appends a one-line hint pointing at PMM/RFQ legs as the likely
cause and suggesting `-v kyber` / `-v odos` for a simulation-friendly route. PMM
orders embed an off-chain maker signature bound to a Permit2 nonce; the maker can
fill another order between `/swap` and our simulation, consuming that nonce and
making `transferFrom` from the maker fail. The user's actual broadcast may still
succeed if their tx lands in the right block — the hint says "likely", not fatal.
The same enrichment is applied to the browser `/simulate` callback.

**RPC requirements** — needs `eth_simulateV1` and `eth_call` with state
overrides. Both are supported by Alchemy (already required for `-d`'s allowance
check) and by Geth/Erigon-based RPCs. Fails loud with a clear message if the RPC
doesn't support them.

**Slot-probe limitations** — the probe finds slots for vanilla
`mapping(address => uint256) _balances` layouts (covers OpenZeppelin and most
major tokens up to slot 31). Proxy-storage / upgradeable / rebasing tokens that
compute balances dynamically will fail with `skipped: could not find balances
slot for <token> — non-standard storage layout`.

**Async venues** — `--simulate` with an async venue is rejected at the simulation
step (`skipped: async venue — no callable swap tx to simulate`). Async orders are
signed and posted off-chain; there is nothing on-chain to simulate at quote time.

# Venues

Everything venue-specific: the adapter contract, per-venue quote/build details,
exact-out & trade side, async (intent-based) venues, the `permit-tx` build kind,
the external-API inventory, and referral / partner fees. General pipeline and
`NormalizedQuote` shape are in [architecture.md](./architecture.md).

## Venue adapter contract

Every venue adapter exports `async function quote(params) → NormalizedQuote` and
a `buildTx(params)`. Each adapter is responsible for:

- Throwing `UnsupportedChainError(venue, chainName)` if the chain isn't
  supported. The adapter's chainId whitelist lives at the top of its file.
- Mapping its response into `NormalizedQuote` — notably flattening whatever
  path/route representation it uses into a single `hops[]` list. `format.ts`
  groups by `hop.tokenIn` to render the "split on X" tree, so adapters must set
  `tokenIn` / `tokenOut` / `swapAmount` consistently in the input token's base
  units.
- Translating native-token addresses at its boundary. Kyber and Velora use
  `0xeee…eee`; Odos uses `0x0000…0000`. The Odos adapter converts both ways.
- Optionally populating `tokenHints: Map<address, {symbol, name, decimals}>` when
  the response carries token metadata for free (Odos does via
  `pathViz.nodes`/`links`). Hints let `index.ts` skip `resolveAddresses` for
  already-known intermediates.
- Every quote is capped at 15s (`VENUE_TIMEOUT_MS` in `src/venues/http.ts`). A
  timeout is a venue error, same as any other fetch failure.

> **Odos is discontinued** (2026-07-30, app + API shut down; every host answers
> `530 Cloudflare Tunnel down`). Both `odos` and `odosv2` are **disabled**:
> `ODOS_DISCONTINUED` in `src/venues/index.ts` drops them from `availableVenues()`
> (silently absent from `-v all`, and from the dApp's venue list) and makes an
> explicit `-v odos` / `-v odosv2` fail loud. The adapters below are kept for
> reference and still compile — flip the flag to re-enable them.

Sync vs. async: **sync** venues (`kyber`, `odos`, `odosv2`, `velora`, `matcha`,
`1inch`, `uniswap`, `curve`, `openocean`) return a `NormalizedTx` (`kind: "tx"`);
**async** venues (`cow`, `delta`, `uniswapx`, `fusion`, `ophis`) return a
`NormalizedOrder` (`kind: "order"`). Uniswap can additionally return a `NormalizedPermitTx`
(`kind: "permit-tx"`) — see [below](#permit-tx-buildresult-kind).

## Per-venue build specifics

- **Kyber** — `POST /route/build` with the `routeSummary` from `quote.raw`.
  Returns routerAddress + calldata. Gas and gasPrice from the quote response are
  reused. Spender = router.
- **Odos** — *discontinued 2026-07-30, venue disabled.* V3 shipped a combined quote+assemble at `POST /sor/swap/v3` (same
  request body as `/sor/quote/v3`, response shape `{quote, assembly:
  {transaction: {to, from, data, value, gas, gasPrice, chainId, nonce}}}`). We
  use it directly — no separate `/sor/assemble` step (V3 pathIds are rejected by
  the unversioned `/sor/assemble` with errorCode 3110). Spender = tx.to.
- **Odos V2** (`-v odosv2`) — *discontinued 2026-07-30, venue disabled.* Kept alongside V3 because V2's router didn't apply
  V3's protocol-fee-aware path filtering, so for some pairs V2 returns a strictly
  better quote (typically 1–3 bp better on stable-stable WETH/stETH-style legs).
  Quote via `POST /sor/quote/v2`, then the legacy two-step build: re-quote with
  `userAddr` to mint a fresh pathId → `POST /sor/assemble`. No API key, no
  enterprise host.
- **Velora** — `POST /transactions/{chainId}?ignoreChecks=true&ignoreAllowance=true`
  with the `priceRoute` from `quote.raw`. Velora prices expire quickly — if the
  build fires more than ~30s after the quote you'll see `408 Price Timeout`; just
  re-run. **Spender = `priceRoute.tokenTransferProxy`**, not `tx.to` (the Augustus
  router). Approving the router would not work.
- **Matcha (0x)** — quote and build both use the allowance-holder product
  (`GET /swap/allowance-holder/price`, then `GET /swap/allowance-holder/quote`),
  not Permit2/Settler. Quote sends the same `slippageBps` the build will send,
  so the displayed route is searched at the execution tolerance. No EIP-712
  signature required. Spender = AllowanceHolder = tx.to. The v2 `fees` object
  (`integratorFee` / `zeroExFee` / `gasFee`, each `{amount, token, type} | null`)
  is parsed into `protocolFee` by `parseMatchaFees` — informational only, since
  `buyAmount` is already net of every fee; entries on the same token are summed,
  an entry on the other side of the pair is logged rather than dropped.
- **1inch** — `/swap/v6.0/{chainId}/swap` with `disableEstimate=true` so the API
  skips balance/allowance checks and returns calldata unconditionally. Spender =
  tx.to.
- **OpenOcean** — Swap API v4. Keyless on the public host
  (`open-api.openocean.finance`, 2 rps); Cloudflare 403s headerless CLI fetch,
  so the adapter sends `Origin`/`Referer` matching `app.openocean.finance`.
  With `OPENOCEAN_API_KEY` it switches to the enterprise host
  (`open-api-enterprise.openocean.finance`, `apikey` header). Chains:
  eth/bsc/base/arb/avax/polygon/xdai (short chain codes in the URL path). Uses the wei-denominated
  `amountDecimals` / `gasPriceDecimals` params (the legacy human-unit params
  are deprecated); slippage is in **percent**; the native sentinel is already
  `0xeee…eee`, no translation needed. The quote adapter folds the response's
  `price_impact` into the normalized `amountOut` (reduce-only, bails on
  implausible values) because OpenOcean's raw `outAmount` is a pre-impact
  mid-price estimate — see
  [quote-accuracy.md](./quote-accuracy.md#the-openocean-bug-fixed). Build =
  `GET /v4/{chain}/swap` with `account`; spender = tx.to. Sell-only.
- **Uniswap (classic)** — quote via Trading API `/v1/quote` with `protocols:
  ["V2", "V3", "V4"]` (pins the search to AMM routes — UniswapX intent routes are
  excluded at the API level, so no post-hoc CLASSIC filter is needed). Build
  picks one of three paths based on route shape and whether either side is native
  ETH:
  - **Hand-rolled fast path** for ERC20→ERC20, single-path, pure V2 or pure V3.
    Pure V3 → `SwapRouter02.exactInputSingle` (single-hop) or `exactInput`
    (multi-hop, with the standard `tokenIn[20] + fee[3] + … + tokenOut[20]` packed
    path). Pure V2 → `UniswapV2Router02.swapExactTokensForTokens`. Both routers
    accept direct ERC20 approvals — no Permit2. Spender = SwapRouter02 (V3) or
    UniswapV2Router02 (V2). Returns a regular `NormalizedTx`.
  - **Path A — native ETH input.** No Permit2 signature needed (Universal Router
    takes msg.value directly). buildTx re-quotes with the real sender, calls
    `/v1/swap` with just `{quote}` (no signature) and returns a `NormalizedTx`
    with `value` set to the input wei amount. The `permit-tx` step is skipped
    entirely.
  - **Path A — V4 / split / mixed (ERC20→ERC20 or ERC20→ETH).** Returns a
    `NormalizedPermitTx` carrying the EIP-712 Permit2 PermitSingle to sign.
    Spender = Permit2. After signing, `/v1/swap` is called with `{quote,
    permitData, signature}` and returns the broadcastable tx.

  Reuses `UNISWAP_API_KEY` (same env as `uniswapx`). Native ETH input/output is
  handled by Universal Router's WRAP_ETH / UNWRAP_WETH commands, transparently to
  us.
- **Curve** — no REST endpoint; quote and build are delegated to `@curvefi/api`
  ("curve-js"). On first call per chain `ensureInit` runs `curve.init("JsonRpc",
  { url: rpc, batchMaxCount: 10 }, { chainId })` (ethers v6 provider + on-chain
  MetaRegistry / AddressProvider / factory discovery) followed by six parallel
  `factory.fetchPools()` HTTP GETs to `api.curve.finance` (`factory`,
  `cryptoFactory`, `stableNgFactory`, `twocryptoFactory`, `tricryptoFactory`,
  `crvUSDFactory`). Init is the dominant cost — ~12 s cold on mainnet — but is
  cached in-process; subsequent quotes within the same CLI invocation reuse the
  graph and are essentially free. Quote calls
  `router.getBestRouteAndOutput(in, out, amountHuman)`, which enumerates
  candidate hops and probes them via on-chain `get_dy`; routes may span 1–4 hops
  through stable / crypto / TwoCrypto NG / TriCrypto NG / crvUSD pools. Build
  calls `router.populateSwap(in, out, amountHuman, slippagePct)` which returns
  unsigned RouterNG calldata; `spender = tx.to` (the RouterNG address). Native
  ETH on either side is handled inside curve-js — both `0xeee…eee` (KyberSwap
  sentinel) and `0x000…000` (Odos / curve-js sentinel) are accepted on input;
  `normalizeNative` collapses both back to `0xeee…eee` for our hops display.

### curve-js noise containment

curve-js's route-graph + route-finder run inside Web Workers that print "Read N
pools, routerGraph: M items" banners. `installCurveWorkerSilencer` (called once
at module load) installs a `globalThis.Blob` proxy that detects the worker
payload by source marker (`routeFinderWorker` / `routeGraphWorker`) and prepends
`console.log = () => {}` to the worker source before it runs. Main-thread
`console.log` is also silenced around `init` and the `getBestRouteAndOutput` call
window. The proxy is permanent for process lifetime; the main-thread patch is
restored in a `finally`. ethers v6's `JsonRpcProvider` registers a polling timer
that keeps the event loop alive, so `cleanup()` (called from `index.ts` on
shutdown) destroys the provider to let the CLI exit promptly.

### Curve gas estimation

curve-js doesn't expose a quote-time gas estimate, so the adapter leaves
`gasUnits` null and `src/gas_usd.ts` synthesizes one from the route shape (150k
per stableswap-flavoured hop / 220k per cryptoswap hop, +50k once for multi-hop
RouterNG overhead). See
[Gas USD fallback](./architecture.md#gas-usd-fallback-srcgas_usdts).

## Exact-out (`--exact-out` / side=buy)

Two-pass race:

1. **Native buy** — `BUY_CAPABLE_VENUES` only (`velora`, `matcha`, `uniswap`,
   `cow`, `ophis`) quote with `side=buy` / fixed `amountOut`.
2. **Sell refine** — once a best native-buy `amountIn` seed exists, sell-only
   venues that are otherwise ready are quoted as **exact-in** at that seed.
   Survivors need `amountOut ≥` the receive target and are tagged
   `quote.buyRefine = { targetAmountOut, seedAmountIn }`. Build rewrites to
   `side=sell` and caps slippage via `sellSlippageBpsForMinOutFloor` so min-out
   never falls below the typed receive amount.

- **CLI** — `--exact-out` denominates `<amount>` in tokenOut. Rejected for
  send/wrap/special actions and for `amount=max`. Explicit single sell-only
  (`-v kyber --exact-out`) still throws `UnsupportedSideError`. Multi-venue
  (`-v all` / comma list) runs the refine pass; sell-only that never raced
  still appear as skipped rows.
- **Ranking** — `pickBest` / `sortRoutesBySide` / dApp `rankRoutesBySide` in
  `shared/rank.ts`: sell → max rank key (`minAmountOut` when present, else
  `amountOut`); buy → min rank key, then max gross `amountOut` on ties
  (refine surplus). Fusion's headline cote is optimistic (auction start);
  the signed floor is `minAmountOut`. When CoinGecko prices both the
  variable-leg token and the native gas token, the key is net-of-gas token
  units. Async quotes count as zero user gas in net mode (solver/filler pays).
  Sync quotes missing `gasUnits` or `gasPriceWei` sink under net. Non-positive
  keys sink. `/api/quote` ranks gross.
- **`/api/mode` `buyVenues`** — native buy capability only (unchanged contract).
- **API** — quote/stream still take **exactly one** of `amountIn` | `amountOut`.
  route/build on buy may send **both** when the chosen route is sell-refine
  (`amountOut` = target, `amountIn` = pay seed). Sell-only + buy without
  `amountIn` → HTTP 400.
- **Build / allowance** — native buy: `side` + `amountOut`, allowance =
  `maxAmountIn(estimate, slip)`. Sell-refine: exact-in at seed, allowance =
  exact `amountIn`, min-out floored at target.
- **dApp** — dual-edit You pay / You receive; refine routes carry `buyRefine`
  and re-send both amounts on build/route.
- **Slippage math** — `src/slippage.ts` (`minAmountOut`, `maxAmountIn`,
  `sellSlippageBpsForMinOutFloor`).

## Async (intent-based) venues

Async venues (`cow`, `delta`, `uniswapx`, `fusion`, `ophis`) return a
`NormalizedOrder` with `kind: "order"`. The user signs `order.typedData` (EIP-712) and POSTs to
`order.submit.url` with the signature spliced into `order.submit.bodyTemplate`; a
filler/solver settles the order on-chain inside `validUntilSec`.

**Per-venue notes**:

- **`cow`** — keyless. Spender = `GPv2VaultRelayer` (`0xC92E…0110`, deterministic
  per chain). Quote endpoint requires `from`; uses `0x…dEaD` placeholder for the
  quote-only path.
- **`delta`** (Velora Delta) — keyless. Spender = `deltaAddress` returned by
  quote (Portikus settlement, currently `0x0000…C96D`). SELL-only — Delta does
  not support BUY orders. Build re-quotes with the real sender because Velora
  binds an HMAC to `userAddress`; sending the original `delta` payload through the
  build endpoint untouched is required (mutating any field invalidates the HMAC).
- **`uniswapx`** — needs `UNISWAP_API_KEY` from hub.uniswap.org. Spender =
  Permit2 (`0x0000…0022D…3AC78BA3`, fixed everywhere). Build re-quotes with the
  real sender (the order's `swapper` field is bound to the signer). Quote and
  build pin `protocols: ["UNISWAPX_V2"]` so the API only considers Dutch V2 intent
  routes — no risk of falling back to a regular Uniswap router tx. The Trading API
  rejects mixing `UNISWAPX_V2` + `UNISWAPX_V3` in the same `protocols` array
  (`"value" contains an invalid value`) and `UNISWAPX_V3` alone currently returns
  no quotes, so V2 is the only working option. Submit body is the modern Trading
  API shape `{ signature, routing, quote }` (the full quote envelope from
  `/v1/quote`, not the legacy uniswapx-service `{encodedOrder, orderType,
  chainId, quoteId}`). `routing` stays the API enum (`DUTCH_V2`). Submit
  requires `x-api-key` (`submit.auth: { kind: "api-key", envVar:
  "UNISWAP_API_KEY" }`); browser/dApp proxy through `/submit` like fusion.
- **`fusion`** (1inch Fusion) — reuses `ONEINCH_API_KEY`. Quote stays on the
  lightweight raw-fetch adapter (the quoter returns **per-token** USD spot prices
  — the adapter scales them by the human amounts before filling
  `amountInUsd`/`amountOutUsd`). Headline `amountOut` is the expected cote
  (`toTokenAmount`); `minAmountOut` is the recommended preset's
  `auctionEndAmount` (the signed `takingAmount` / Dutch-auction floor).
  `pickBest` ranks on `minAmountOut` so Fusion cannot win with a start-of-auction
  teaser. Quote and `createOrder` send the same `slippage` (percent =
  `slippageBps / 100`). Build lazy-imports `@1inch/fusion-sdk` and calls
  `sdk.createOrder` (re-quotes with the real maker, wraps the recommended auction
  preset into a Limit Order Protocol v4 struct + the Fusion extension blob). The
  typed data's domain is the **LOP v4 router** (`0x1111…2A65` — also the spender;
  the settlement extension contract never pulls funds), `primaryType: "Order"`.
  Submit body = `{order, signature, quoteId, extension}` to `POST
  /fusion/relayer/v2.0/{chainId}/order/submit`. The relayer **requires the Bearer
  key** (see [Authed submit](#authed-submit-submitauth)). `orderHash` is computed
  client-side by the SDK and carried on the order for display / empty-response
  fallback. The SDK is passed a small fetch-backed `httpProvider` (its default
  axios connector is never used, but `axios` must be installed because the SDK's
  module graph imports it statically).
- **`ophis`** — CoW Protocol fork, gated by `OPHIS_REFERRAL_CODE` (unset → the
  venue is filtered out of `-v all` like a missing API key — it would otherwise
  just be CoW plus an unrebated fee). On CoW-hosted chains
  (eth/arb/base/bsc/avax) orders settle via CoW's canonical GPv2 contracts;
  Ophis-**operated**
  chains (unichain) run Ophis's own settlement / vault relayer / eth-flow /
  orderbook deployments. Every per-chain address (orderbook host, signing
  domain, vault relayer, eth-flow contract) comes from `@ophis/sdk` — never
  hardcoded. The order's appData carries `appCode: "ophis"`, the CIP-75
  `partnerFee` from `buildOphisAppDataPartnerFee(chainId, isStablePair)`
  (1 bp base Volume on every served chain; on CoW-hosted chains also a
  pair-aware PriceImprovement entry — volatile 80% of reference-quote
  improvement capped at 99 bps, stable 50% capped at 20 bps; Ophis-operated
  backends apply improvement server-side so appData is Volume-only there), and
  the `ophisReferrer` code; the full appData JSON is `PUT` to the orderbook
  before submit (mandatory — the on-chain order only commits the hash, and
  without the doc the fee and rebate silently drop). Displayed **and** signed
  amounts fold the flat Volume fee in (`normalizeOphisQuoteAmounts` /
  `ophisSignedOrderAmounts`); PriceImprovement is surplus-sourced at
  settlement and is not folded into the limit. The signed `feeAmount` is
  always `"0"` (orderbook NonZeroFee rule). BUY-capable (`kind: buy`).
  Native-ETH **input** is supported on eth-flow chains as an on-chain
  `createOrder` tx (sell-side only; spender = the eth-flow contract, no ERC20
  approval fires) — elsewhere it errors with a "wrap to WETH" message. Build
  also runs a one-time `enrollOphisTrader` (rebate-indexer enrollment). No hops
  are exposed (the solver auction decides settlement). Self-check:
  `bun run src/venues/ophis.ts`.

**`--allow-async`** — async venues change *output semantics* (sign + POST vs
broadcast a tx), so opt-in must be explicit. Without the flag, async venues are
filtered out of `availableVenues()` (silent skip in `-v all`, mirroring
missing-API-key behavior) and explicit `-v cow` throws
`AsyncOptInRequiredError`. With the flag, async venues participate in `pickBest`;
the comparison block tags their rows `(intent)`. Fusion also surfaces
`minAmountOut` (auction-end floor) next to the cote; ranking uses that floor,
not the pre-decay headline.

**Native-token input** — the signed-order path can't pull native ETH as
`tokenIn` (settlement contracts pull ERC20s via `transferFrom` / Permit2 —
there's no path to pull msg.value because the user signs an off-chain order,
never sends a tx). `cow`, `delta`, `uniswapx`, and `fusion` reject
`NATIVE_SENTINEL` for `tokenIn` with a clear "wrap to WETH" message. `ophis` is
the one exception: on eth-flow chains a native-ETH **sell** goes through the
on-chain eth-flow `createOrder` tx instead (see its note above).

**Native-token output** — *is* supported by all five. The settlement contracts
(CoW's / Ophis's GPv2Settlement, UniswapX's Reactor, Velora's Portikus, 1inch's
Fusion settlement) unwrap WETH → ETH at the end of the order when the buyToken /
outputToken / destToken / dst is the native sentinel. We pass `NATIVE_SENTINEL`
through unchanged; each venue's API accepts it.

**Quote-only sender placeholder** — async venues that require a sender at quote
time (cow, delta, uniswapx, fusion, ophis) use
`0x000000000000000000000000000000000000dEaD` when no `--from`/`SENDER_ADDRESS` is
configured. The placeholder is **only** for indicative pricing — it never enters
a signed order. The build path always re-quotes / re-fetches with the real
sender, because each venue binds something to the signer's address (CoW: `from`
field; Delta: HMAC; UniswapX: `swapper`; Fusion: maker; Ophis: `from` /
`receiver`).

**JSON output for orders** — `--json` emits top-level `kind: "order"`, `tx:
null`, and `order: NormalizedOrder`. The full `order.typedData` is suitable for
`cast wallet sign-typed-data --data <file>` (write it to a file via `jq
.order.typedData > order.json`).

### Authed submit (`submit.auth`)

Relayers that require an auth header (fusion → 1inch Bearer key) carry
`submit.auth: { kind: "bearer" | "api-key", envVar }` instead of the
secret itself (`bearer` → `Authorization: Bearer`, `api-key` → `x-api-key`).
Terminal mode prints an `auth` row telling the user which header to attach;
`--json` consumers resolve the env var themselves. The `--browser` and
interactive-dApp flows **proxy** the submission through the local server:
`buildPayload` / `/api/build` rewrite `submit.url` to the local `POST
/submit?id=<sid>` (and strip `auth` from the payload), the server forwards the
signed body to the real relayer with the header attached (`proxyOrderSubmit` in
`browser.ts`, shared by `serve.ts`). The key never reaches the page, and the
relayer's missing CORS support never matters. On a 2xx-with-empty-body relayer
response, the proxy answers `{orderId: order.orderHash}` so `SignOrder`'s id
extraction works unchanged.

## `permit-tx` BuildResult kind

Some sync Uniswap routes can't be hand-rolled locally (V4 needs PoolKey
reconstruction; split / mixed routes need Universal Router + Permit2 calldata
encoding). Instead of throwing, those routes return a `NormalizedPermitTx`
carrying the EIP-712 Permit2 PermitSingle the user must sign. Workflow:

1. Initial `/v1/quote` happens with a dEAD-placeholder swapper (no sender at
   quote time).
2. `buildTx` re-quotes with the real sender so `permitData.swapper` / `nonce`
   bind to them — the routing is unchanged, only the permit fields differ. The
   fresh raw replaces `quote.raw` (mutation; the orchestrator's `winnerQuote`
   reference picks it up so the assemble step sees the same data).
3. The `NormalizedPermitTx` carries `typedData` (cleaned of `EIP712Domain`) plus
   `spender = Permit2`, `signer = sender`, `chainId`. Allowance check uses Permit2
   as the spender.
4. `--browser` payload kind = `"permit-tx"`. The web page's `SignPermitTx`
   component renders typed data, signs via wagmi `useSignTypedData`, then POSTs
   the signature to the server's `/assemble?id=…` endpoint.
5. The server's `/assemble` handler invokes the per-session `assemble(signature)`
   callback. For uniswap that calls `assemblePermitTx({venue:"uniswap", chain,
   sender, signature, quote})` → `uniswap.assemble(...)` → `POST /v1/swap` with
   `{quote, permitData, signature}` (the API key never leaves the local server).
   Response carries `swap.{to, from, data, value, gasLimit, maxFeePerGas,
   maxPriorityFeePerGas, chainId}` which we map to a `NormalizedTx`.
6. The page receives the assembled tx and `sendTransaction`s it; the receipt
   callback POSTs `{kind:"tx", hash, venue, chainId}` to `/done` as usual.

Terminal `-d` mode (no `--browser`) for permit-tx prints the typed-data hint and
tells the user to use `--browser`. JSON mode adds top-level `permitTx:
NormalizedPermitTx` and `kind: "permit-tx"` (mutually exclusive with `tx` /
`order`). `NormalizedPermitTx` is currently produced only by `uniswap.buildTx`.

## External APIs

- **KyberSwap aggregator** — `https://aggregator-api.kyberswap.com/{kyberPath}/api/v1/routes`
  (no key). With `KYBER_API_KEY` set the adapter switches to the API gateway
  `https://api.kyberswap.com/swap/{kyberPath}/api/v1/…` and sends `X-Api-Key`
  (higher limits; key from business@kyber.network). `KYBER_API_BASE` is an
  optional host override; leave unset — the gateway URL is already the default
  whenever the key is set.
- **KyberSwap ks-setting** — `https://ks-setting.kyberswap.com/api/v1/tokens`
  (no key) — used for token resolution & batched intermediary lookup.
- **CoinGecko** — `https://api.coingecko.com/api/v3/{search,coins/{id},coins/{platform}/contract/{addr}}`
  (no key, rate-limited to ~10–30 req/min).
- **Odos** — *discontinued 2026-07-30, venue disabled (no longer called).*
  `POST https://api.odos.xyz/sor/quote/v3` with `pathViz: true` for
  indicative pricing (no key on the public endpoint). Build calls `POST
  https://api.odos.xyz/sor/swap/v3` (combined quote+assemble). When `ODOS_API_KEY`
  is set, both calls switch to `https://enterprise-api.odos.xyz/...` with
  `Authorization: Bearer` — required for `partnerFeePercent` / `feeRecipient` to
  actually apply (the public host accepts both fields but ignores them silently).
- **Odos V2** (`-v odosv2`) — *discontinued 2026-07-30, venue disabled (no
  longer called).* `POST https://api.odos.xyz/sor/quote/v2` for the
  quote, then the legacy two-step build via `POST /sor/quote/v2` (re-quote with
  `userAddr` for a fresh pathId) → `POST /sor/assemble`. No API key, no enterprise
  host. Uses `ODOS_REFERRAL_CODE`.
- **Velora (ex-Paraswap)** — `GET https://api.velora.xyz/prices` (no key).
  `api.paraswap.io` also still works.
- **Matcha / 0x** — `GET https://api.0x.org/swap/allowance-holder/price` — requires
  `ZEROEX_API_KEY` (free at https://dashboard.0x.org). Passed as `0x-api-key`
  header with `0x-version: v2`. Quote includes `slippageBps`. No USD values in
  the response.
- **1inch** — `GET https://api.1inch.dev/swap/v6.0/{chainId}/quote` — requires
  `ONEINCH_API_KEY` (free at https://portal.1inch.dev). Passed as `Authorization:
  Bearer`. `protocols` is triple-nested (paths → levels → parallel routes); the
  adapter flattens it into `hops[]` computing each hop's share from the `part`
  field.
- **Curve via `@curvefi/api`** (no direct REST in our code) — parallel HTTP GETs
  to `api.curve.finance` (one per factory) plus on-chain reads through the
  configured RPC (AddressProvider → MetaRegistry → factory addresses → coin
  metadata). `router.getBestRouteAndOutput` runs `get_dy` eth_calls per candidate
  hop; `router.populateSwap` produces unsigned RouterNG calldata. Reuses the same
  RPC config as `-d`/`--simulate` (never public RPCs).
- **OpenOcean** — `GET https://open-api.openocean.finance/v4/{chain}/{quote,swap}`
  (no key, 2 rps; `Origin`/`Referer` for Cloudflare). With `OPENOCEAN_API_KEY`,
  `GET https://open-api-enterprise.openocean.finance/v4/{chain}/{quote,swap}`
  and the `apikey` header.
- **Ophis orderbook** — CoW-compatible orderbook API (`POST /api/v1/quote`,
  `PUT /api/v1/app_data/{hash}`, order submit). Base URL is per-chain via
  `@ophis/sdk` (`OPHIS_ORDERBOOK_URLS`) — CoW's `api.cow.fi` hosts on CoW-hosted
  chains, Ophis's own orderbook on Ophis-operated chains. No key; the venue is
  gated by `OPHIS_REFERRAL_CODE` instead.
- **Alchemy prices** (USD oracle for Curve gas display) — `GET
  https://api.g.alchemy.com/prices/v1/{ALCHEMY_API_KEY}/tokens/by-symbol?symbols=ETH`.
  Falls back to CoinGecko `simple/price` if the key is unset or Alchemy returns a
  non-numeric. Cached for 60s within a single CLI invocation.

See [conventions.md](./conventions.md#key-loading--key-missing-behavior) for how
API keys are loaded and how missing keys are handled.

## Referral / partner fees

`src/referral.ts` reads referral env vars once and exposes `getReferralConfig()`.
Each adapter calls it inside `quote` and/or `buildTx` and adds the appropriate
fields to the outgoing request. If `REFERRAL_ADDRESS` is unset, no venue charges
anything. Env vars (all optional, all in `.env.example`):

- `REFERRAL_ADDRESS` — recipient of partner fees / surplus. Validated as a 0x
  20-byte address and normalized to EIP-55.
- `REFERRAL_NAME` — free-form attribution label. Maps to velora `partner`, kyber
  `x-client-id`, fusion `source`, and cow `appCode`. Three channels get one
  value each so venue dashboards can tell them apart: the public binary bakes
  `REFERRAL_NAME=swap` into `.env.install`, the hosted dApp sets its own value
  in the Vercel project env, and a self-host uses its `.env`. Unset defaults to
  `swap-selfhost`. The process then appends `-cli`, `-dapp`, or `-browser`, so
  the public binary sends `swap-cli` / `swap-dapp` / `swap-browser` while an
  unconfigured self-host sends `swap-selfhost-cli` and friends.
- `REFERRAL_FEE_BPS` — additional explicit fee in basis points, capped at 1000
  (10%) by `referral.ts`. Each venue further clamps to its own ceiling: 0x
  1000 bps ([docs.0x.org](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap):
  "swapFeeBps has a default limit of 1000 Bps for security"), 1inch 300 bps
  (rejects >3% with a hard 400), OpenOcean 500 bps (their own documented cap).
  Errors at startup if set without `REFERRAL_ADDRESS`.
- `ODOS_API_KEY` — *dead since the Odos shutdown (2026-07-30); read by nothing
  reachable.* Odos enterprise API key. When set, routes Odos requests
  through `enterprise-api.odos.xyz`; required for `partnerFeePercent` /
  `feeRecipient` to actually apply. Without it, Odos falls back to the free public
  endpoint which silently ignores fees.
- `ODOS_REFERRAL_CODE` — *dead since the Odos shutdown (2026-07-30).*
  Odos-registered numeric code, used by the legacy V2
  venue (`odosv2`) only. V3 (`odos`) ignores it and uses `partnerFeePercent` +
  `feeRecipient` instead.
- `COW_REFERRAL_CODE` — CoW Swap affiliate code, used by `cow` only. Embedded in
  the order's appData document as `metadata.referrer.code` (uppercased; must match
  `^[A-Z0-9_-]{5,20}$`). Attribution only — does not alter the quote — so it
  survives `--nofee`. Volume partner fees are a separate `metadata.partnerFee`
  block driven by `REFERRAL_ADDRESS` / `REFERRAL_FEE_BPS` (see the cow note
  below).
- `OPHIS_REFERRAL_CODE` — Ophis rebate code, used by `ophis` only. Embedded in
  the order's appData as `metadata.ophisReferrer.code` (case-sensitive, stored
  verbatim). Doubles as the venue gate: unset → `ophis` is filtered out of
  `-v all` (it would otherwise be CoW plus an unrebated CIP-75 fee).

**Per-venue mapping**

| Venue   | Quote-side                                           | Build-side                                                                                       | Surplus capture |
|---------|------------------------------------------------------|--------------------------------------------------------------------------------------------------|-----------------|
| velora  | `partner`, `partnerAddress`, `partnerFeeBps`, `takeSurplus` | same, in JSON body                                                                          | `takeSurplus=true` whenever `REFERRAL_ADDRESS` is set — invisible to user, doesn't alter quote |
| odos    | *disabled 2026-07-30* — `partnerFeePercent`, `feeRecipient` (V3 — only honored on enterprise host) | same on `/sor/quote/v3` re-quote                                  | n/a |
| odosv2  | *disabled 2026-07-30* — `referralCode` (legacy V2 mechanism, sourced from `ODOS_REFERRAL_CODE`) | same on `/sor/quote/v2` re-quote before `/sor/assemble`              | n/a |
| kyber   | `x-client-id` header; partner-fee quartet (`feeReceiver`, `feeAmount` BPS including 0, `isInBps=true`, `chargeFeeBy=currency_out`) whenever `REFERRAL_ADDRESS` is set | same quartet on `/route/build`; optional `source` and `referral` (from `KYBER_SOURCE` and `KYBER_REFERRAL`) recorded in the on-chain `ClientData` event, attribution only, kept under `--nofee` | quartet at 0 bps registers `feeReceiver`; Kyber's docs still say they keep positive slippage |
| matcha  | `swapFeeRecipient`, `swapFeeBps`, `swapFeeToken=buyToken` on `/allowance-holder/price` — `buyAmount` comes back **net**, and the `fees` breakdown is surfaced as `protocolFee` | same on `/allowance-holder/quote`                                | `tradeSurplusRecipient` whenever `REFERRAL_ADDRESS` is set (honored only once 0x enables surplus on the API key) |
| 1inch   | `referrer`, `fee` (percent), mirroring `/swap`       | `referrer`, `fee` (percent, max 3) on `/swap` — 1inch is meant to keep ~10% of the fee          | n/a — see the note below |
| fusion  | `source`, `fee` (BPS integer) on `/quote/receive`     | `source`, `integratorFee: {receiver, value}` on the SDK's `createOrder`                           | n/a — see the note below |
| cow     | `appData` JSON doc w/ `metadata.referrer.code` (+ `appCode`) and `metadata.partnerFee` `{volumeBps, recipient}`, hashed into `appDataHash` on `/quote`. Quote `amountOut` (sell) / `amountIn` (buy) is netted client-side | quote echoes `appData`/`appDataHash`; `buildOrder` reuses them and nets the same bps out of the signed limit | n/a — CIP-75 volume fee, `REFERRAL_FEE_BPS` clamped to 100 |
| openocean | deducted locally after `applyPriceImpact` (`amountOut × (10000 − feeBps) / 10000`, same 500 bps clamp) and reported as `protocolFee` | `referrer`, `referrerFee` (percent, clamped to 500 bps) on `/swap` — OpenOcean keeps ~20% of the fee | n/a |
| ophis   | `appData` doc w/ CIP-75 `metadata.partnerFee` (1 bp Volume + pair-aware PriceImprovement on hosted chains) + `metadata.ophisReferrer.code`, hashed into `appDataHash` | same doc `PUT` to the orderbook + committed in the signed order / eth-flow tx | n/a — CIP-75 via `@ophis/sdk` `buildOphisAppDataPartnerFee`, `OPHIS_REFERRAL_CODE` |

Velora's surplus capture (`takeSurplus`) and matcha's (`tradeSurplusRecipient`)
are independent of `REFERRAL_FEE_BPS` and get enabled whenever `REFERRAL_ADDRESS`
is set, since they can't worsen the quote (the user gets ≥ the signed
`minAmountOut` regardless). Matcha surplus only actually lands once 0x has enabled
the feature on the API key (custom plan); until then the param is a no-op and 0x
keeps surplus. Explicit BPS fees on the other hand reduce displayed `amountOut`
and will affect `pickBest` ranking versus venues that don't charge — be aware
when comparing.

**Quote must reflect what the build charges.** A venue whose `buildTx` sends a
fee but whose `quote` doesn't would display a gross amount and execute a net one.
Per venue, measured live 2026-08-09 (mainnet, 10 WETH→USDC, `eth_simulateV1`
prank):

- **openocean** — `/quote` *does* honor `referrerFee`, returning `outAmount`
  at exactly ×(1 − fee) (×0.99 at 1%, ×0.995 at 0.5%). We still don't send it:
  OpenOcean also folds the fee into `price_impact` (−0.04% → −1.04% at 1%), and
  `applyPriceImpact` would then charge it a second time. Instead the adapter
  subtracts it in bigint **after** `applyPriceImpact`, giving exactly
  gross × (1 + impact) × (1 − fee) — one impact, one fee — and fills
  `protocolFee` (`side: "out"`). On-chain the fee is actually pulled on the
  *input* token (a 0.04 WETH `Transfer` to `REFERRAL_ADDRESS` at 50 bps, i.e.
  the referrer's 80% share), but OpenOcean prices it as an output reduction and
  we mirror that — the conservative direction.
- **1inch** — `/quote` accepts and validates `referrer` + `fee` but ignores
  them, and so does `/swap`: the calldata is byte-identical with and without,
  the referrer address never appears in it, and a simulated swap at `fee=3`
  delivered *more* than the gross quote with no `Transfer` to
  `REFERRAL_ADDRESS`. Nothing is charged, so nothing is deducted from the
  displayed quote and `protocolFee` stays null. `quote` sends the same params
  as `buildTx` anyway, so the two stay in lockstep if 1inch ever activates
  partner fees for this key. Note `REFERRAL_FEE_BPS > 300` is a hard 400 on
  1inch (`fee must not be greater than 3`) — there is no per-venue clamp.
- **cow** — `metadata.partnerFee` is CIP-75 `{volumeBps, recipient}` at appData
  schema 1.15.0. CoW's partner program caps volume fees at 100 bps
  ([docs.cow.fi](https://docs.cow.fi/governance/fees/partner-fee)) and we clamp
  there, both to stay inside the program and so that what we declare equals what
  we deduct locally. The orderbook enforces no ceiling of its own (measured: 500
  and even 20000 bps quote fine), so the clamp is ours. The quote is **gross**:
  it does not subtract the partner fee, so `normalizeCowQuoteAmounts` /
  `cowSignedOrderAmounts` net it client-side the same way the CoW SDK's
  `getQuoteAmountsAfterPartnerFee` does (protocolFeeBps = 0). Sell reduces
  `amountOut`; buy grows `amountIn`. `buildOrder` re-reads the bps from the
  echoed appData rather than from env, so a drifted `REFERRAL_FEE_BPS` cannot
  sign a limit that does not match the fee the order declares. `--nofee`
  drops `partnerFee` and keeps the free `referrer.code`. With neither a code
  nor a fee we still send the canonical empty `"{}"` doc so a default order
  is byte-for-byte unchanged.
- **fusion** — `source` is accepted and echoed back in the quote response, but
  any non-zero `fee` is a hard **400**, not a silent no-op like 1inch classic:
  `"fee is not allowed"` when a `source` is present,
  `"integrator fee parameters provided but customer fee is disabled"` without
  one. 1inch gates integrator fees per key and they are off by default, so the
  fee is opt-in via `FUSION_FEE_ENABLED=1` (set it once 1inch enables it on
  your `ONEINCH_API_KEY`); without the flag fusion sends only `source`, and
  quote and build read the same flag so they never diverge. There is no
  per-venue clamp: every non-zero value is refused on a disabled key, so any
  ceiling would be a guess. Note the wire unit is **BPS, not percent**
  (`fee=50` for 0.5%), matching the SDK's `QuoterRequest.build()`, which
  serialises `Number(integratorFee.value.value)`.
  `source` itself is pure attribution and does not move the price: measured
  2026-09-03 over five interleaved rounds (mainnet, 1 WETH→USDC),
  `source=0x` (the old hardcoded value), `source=swap-cli`, and the SDK's
  `surplus=true` returned amounts indistinguishable from each other inside the
  ±0.02% the Dutch-auction quote drifts between successive calls.

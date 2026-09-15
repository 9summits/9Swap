# Interactive dApp & browser flow

The `swap` binary has two browser-facing surfaces: a full **interactive dApp**
(run `swap` with no arguments) and a **sign-only browser bridge** (`--browser`,
opened after a CLI quote). Both are served by the same embedded React bundle and
delegate to the same stateless request handlers. The same code also deploys to a
serverless target — see the [Vercel target](#vercel-target) section and
[vercel.md](./vercel.md) for deployment steps.

## Interactive dApp (`swap` with no args)

Running `swap` with **no positional arguments** launches an interactive branded
swap dApp (a DeFiLlama-style meta-aggregator): pick token/amount/chain in the
browser → every venue is quoted server-side → the ranked route comparison is
shown → pick a route → connect wallet → approve/swap (or sign an async order).
`swap --help`, `swap 1 WBTC ETH`, `--init`, `swap update`, etc. are unaffected — the trigger is
a `process.argv.slice(2).length === 0` check at the top of `main()` in
`index.ts`, before commander parses (`--init` and `update` are intercepted the
same way).

- **`src/serve.ts`** — `startServeSession()`: a **long-lived** `Bun.serve()`
  (port 5151 + fallback, `idleTimeout: 120`) that stays up until Ctrl-C (SIGINT →
  `venues.shutdown()`). It is a thin shell: sid / `SWAP_NO_AUTH` gate + embedded
  bundle + delegation to **`src/server/handlers.ts`** — the same stateless
  handlers the serverless functions mount, so local and deployed behavior can't
  drift. (`idleTimeout` is bumped from Bun's 10s default because that would sever
  the NDJSON quote stream between slow venue lines.)
- **`src/core.ts`** — the commander-free composition layer the handlers call. It
  wraps the already-standalone primitives (`fetchAllQuotes` / `pickBest` /
  `build` / `assemblePermitTx` from `venues/index.ts`; `resolveToken` /
  `resolveChain`; `getAllowance` / `buildApproveData` / balances from `rpc.ts`;
  `fillGasUsdAll`; wrap/send short-circuits) and **mirrors `index.ts`'s
  orchestration** so the CLI and dApp quote/build identically — without importing
  `index.ts` (which would run `main()`). Handler load also calls
  `setPublicRpcFallback(true)`, so allowance, decimals, and gasPrice last-resort
  to `CORS_OPEN_RPC` when Alchemy and per-chain overrides are unset. CLI
  `-d` / `--simulate` / `--browser` do not enable that fallback.

The frontend lives in `web/src/dapp/` (interactive components on the design
system in `web/src/ds/`), routed by `web/src/App.tsx` on the `/api/mode`
response.

## `/api/*` endpoint contract (stateless)

The contract is **STATELESS**: no server-held quote cache, no pending permit /
order. Every handler reconstructs its inputs from the request body. `quoteId` in
responses is a client-side round key only; nothing consumes it server-side.
Endpoints are sid-gated locally and gateless on the serverless target.

- `GET /api/mode` → `{ interactive, apiVersion, sid, chains, venues, buyVenues,
  defaultChain, walletConnectProjectId }`. The page calls this first; an
  interactive response renders the dApp, otherwise it falls back to the legacy
  `--browser` sign-only page (one bundle, two modes). `venues` excludes anything
  in `SWAP_DISABLE_VENUES`; `buyVenues` is `BUY_CAPABLE_VENUES` for exact-out UI
  filtering. `apiVersion` (`API_VERSION` in `src/server/shared.ts`, currently
  `1`) is the version of this wire contract: non-browser clients — the CLI's
  hosted mode — read it to tell a current deployment from one predating a field
  they need. A deployment older than the constant omits the key entirely, which
  reads as "pre-versioning". Bump it only when the contract gains or breaks a
  field; the dApp ignores it (it ships with the server that serves it).
- `GET /api/tokens?chain=` → curated per-chain list (KyberSwap ks-setting
  whitelist, paginated to ~300, native prepended, 10-min cache). Each
  `logoURI` is rewritten to `GET /api/icon?chain=&address=` so the browser
  and Vercel CDN cache the image (7 / 30 days) and third-party icon hosts
  never see the visitor. The dApp also persists decoded blobs in Cache
  Storage so picker remounts and reloads don't flash empty coins.
- `GET /api/icon?chain=&address=` → proxied token image, whitelist-only
  (looked up in the curated list, never an open proxy). Exempt from the
  session gate and from the Vercel rate limiter.
- `POST /api/resolve-token` `{chain,input}` → `{address,symbol,name,decimals}`
  (paste any 0x address or symbol; wraps `resolveToken`).
- `POST /api/quote` and `POST /api/quote/stream` (NDJSON: `meta` →
  `route`/`verror` per venue as each settles → `done`)
  `{chain,tokenInAddress,tokenOutAddress, amountIn|amountOut (XOR), side?,
  slippageBps, allowAsync, venues?}` — the `-v all` engine (no wallet needed;
  routes ranked best-first by side; USD/price-impact derived from venue-provided
  `amountInUsd`/`amountOutUsd`).

  Both handlers emit the **same row shape** through one mapper,
  `routeQuoteWire()` in `src/server/handlers.ts` — `/api/quote` in `routes[]`
  (ranked), the stream in each `{type:"route", route}` event (settle order).
  Per row: `venue`, `amountIn`, `amountOut`, `minAmountOut?`, `gasUsd`,
  `priceImpactPct`, `kind`, `gasUnits`, `gasPriceWei`, `amountInUsd`,
  `amountOutUsd`, `buyRefine?`, plus four fields the terminal renderers need:

  - `hops` — the venue's `NormalizedHop[]` verbatim, token **addresses** (the
    native sentinel for the chain coin, or an opaque positional label from
    venues that expose no intermediate address). Not to be confused with
    `/api/route`'s `hops`, which are symbol-labelled for the route graph.
  - `router` — `string | null`, the venue's router/settlement contract.
  - `protocolFee` — `{raw, sharePct, side:"in"|"out"} | null`.
  - `tokenHints` — `NormalizedQuote.tokenHints` (a `Map`) serialized as a plain
    object keyed by lowercase address; `{}` when the venue ships none.

  `hops` / `router` / `protocolFee` / `tokenHints` / `amountInUsd` /
  `amountOutUsd` are **always present** (possibly `null` / `[]` / `{}`), so a
  client can round-trip a row back into a `NormalizedQuote` without a second
  call — that is what `src/format.ts` and `src/json.ts` consume in hosted mode.
  `raw` (the venue's untouched API response) is never serialized: unbounded,
  venue-specific, and a plausible bigint carrier. The dApp ignores the four
  additions; they were purely additive.
- `POST /api/route` `{chain, venue, amountIn|amountOut, slippageBps?, tokenIn:
  {address,symbol,decimals}, tokenOut: {…}}` → symbol-labelled hops for the route
  graph. Stateless: re-quotes the single venue fresh. Validates the venue against
  `VENUES` + `SWAP_DISABLE_VENUES` (`venueFromWire`) so a crafted request can't
  reach a disabled venue; sell-only venue + amountOut → 400.
- `POST /api/build` `{venue, sender, recipient?, slippageBps?, chain, tokenIn:
  {…}, tokenOut: {…}, amountIn|amountOut, odosNotCompact?, disableOdosRfq?}` → a
  **`Payload`** identical to `web/src/payload.ts`. The client sends fully-resolved
  token metadata (no network resolution server-side; decimals are validated,
  never coerced). The chosen venue is **re-quoted fresh** before building (Odos
  pathIds / Velora priceRoutes go stale within ~30s). Optional
  `odosNotCompact: true` mirrors the CLI `--odosnotcompact` flag (force
  `compact: false` on the odosv2 build re-quote; ignored for other venues).
  Optional `disableOdosRfq: true` mirrors `--disableodosrfq` (odos/odosv2 send
  `disableRFQs: true` — workaround for tokens like FXN that trip Odos errorCode
  2999 on the RFQ path). Both are controlled by the dApp Settings → Advanced
  toggles. For `kind:"permit-tx"` the payload carries an opaque
  **`assembleContext`** `{venue, chain, sender, quote}` (bigint-sanitized) that
  the page echoes back on `/assemble`. Allowance is checked for sync tx **and**
  async order (skipped for native/wrap/send); buy uses the `maxAmountIn`
  ceiling.
- `POST /assemble` `{signature, context}` — Permit2 second leg, stateless: the
  context is the build's `assembleContext`, handed back verbatim.
- `POST /submit?venue=…&chainId=…&orderHash=…` — authed-order submission leg
  (fusion). The relayer URL is reconstructed **entirely server-side** from the
  whitelisted venue + integer-validated chainId (never from a client-supplied URL
  — that would be an open proxy attaching the API key); `rewriteAuthedOrderSubmit`
  puts those params in the payload's `submit.url`. `proxyOrderSubmit` uses
  `redirect: "manual"` so a 3xx can never resend the Bearer key elsewhere.
- `POST /simulate` — returns `{kind:"skipped"}` (simulation isn't surfaced in the
  v1 dApp).
- `POST /done` takes a discriminated union on `kind`. The three bodies are
  `{kind:"tx", hash, venue, chainId}`, `{kind:"order", orderId, venue, chainId}`
  and `{kind:"error", error, venue, chainId}`. `parseDoneReport`
  (`src/server/done_report.ts`) validates it at the boundary, and a body that
  fails validation returns 400 with the reason logged. A valid report writes one
  structured JSON line to **stdout**, e.g.
  `{"evt":"done","kind":"tx","venue":"kyber","chainId":1,"hash":"0x…"}`, with
  exactly one of `hash` / `orderId` / `error` after `chainId`. That line is what
  lets us count swaps per venue, chain and outcome from server logs alone. Caps
  are 64 chars on `venue`, 128 on `hash` and `orderId`, 100 on `error`. The
  client sends no address or amount field at all; the only free text is the
  wallet's `error` message, which is capped and has embedded 20-byte addresses
  scrubbed to `0x…` before it is logged. The human-readable line still
  goes to stderr, and the session stays up for the next swap.

**Balances** are read **client-side** via `publicClientFor` in `web/src/wagmi.ts`
— through the injected wallet's RPC when it sits on the selected chain, the
chain's default public RPC otherwise. There is deliberately no `/api/balances`:
per-visitor reads must not consume the server's Alchemy quota (and the endpoint
would be an open quota hole under `SWAP_NO_AUTH` / on the serverless target).

Two client-side cycles:

- **Pair (live).** `tokenIn` / `tokenOut` only, refetched on each block (~4s) and
  after a confirmed swap. Powers the MAX button and the pay-side readout.
- **Picker snapshot.** Multicall3 `balanceOf` over the curated list plus custom
  and recent tokens (`web/src/dapp/walletBalances.ts`), on connect, when the
  picker opens, and after a confirmed swap. Non-zero holdings pin to the top of
  the picker as "Your tokens". Not on the block watcher.

## Client-side curve (`web/src/dapp/curve/client.ts`)

On deployments where the server doesn't offer curve, the **browser** runs it: the
visitor's tab pays the curve-js init once (their RPC, never the server's Alchemy
quota) and the route merges into the stream. Activation requires all three of:
(a) `mode.venues` does NOT contain curve (so the client never duplicates a
server-side curve venue), (b) the chain is in the module's whitelist (mirrors
`src/venues/curve.ts`), (c) the curve toggle is on (a synthetic VenueMeta is
added to the settings list when (a)+(b) hold).

- `@curvefi/api` is **dynamic-import only**: a lazy chunk in the serverless build;
  `rollupOptions.external` in the embed build so the CLI binary doesn't grow (the
  local CLI path never executes it — curve is server-side there).
- Init provider: injected wallet when it reports the target chain, else a
  **CORS-open public RPC** (`CORS_OPEN_RPC` table, PublicNode) — viem's defaults
  (mainnet's eth.merkle.io) reject browser origins, which would kill the no-wallet
  path. Init is per-chain (curve-js is a global singleton), guarded by a 90s
  timeout + retry-on-next-round, with `console.info` breadcrumbs for field
  debugging.
- `quoteCurve` → `getBestRouteAndOutput` (exact base-unit conversion, no floats) +
  hop mapping for the sankey (`getCoinsData` for intermediary symbols,
  address-truncation fallback). `buildCurve` → fresh re-quote + `populateSwap` +
  client-side allowance read via `publicClientFor` (wallet provider when on
  the selected chain, else `CORS_OPEN_RPC` — never viem's `eth.merkle.io`
  default, which rejects browser origins) + approve calldata → a
  `Payload kind:"tx"` that feeds `<SendTx>` unchanged. The first cold `getBestRouteAndOutput` can
  outlive a 30s round (the anti-stale guard drops the result); the row joins on
  the next round once the route graph is warm.
- `useQuote` injects the curve route into the round (`clientSide: true` marker),
  re-sorts, re-derives best; `InteractiveDapp` routes build/route-graph for
  clientSide routes to the module instead of `/api/build` // `/api/route`.
  Manual and auto refresh purge the route list. Venues then stream in as
  each `route` or `verror` arrives. Client-side curve updates only its own
  row. `done` drops venues that did not settle this round.

`useQuote` fills that row's `gasUsd` with the same hop heuristic and ETH_USD=2000
formula as `fillGasUsd`. Gas price comes from `eth_gasPrice` on the CORS public
client (`publicClientFor`, no wallet). The fill is skipped when the chain native
is not ETH. No new endpoint.

## Browser flow (`--browser`)

`startBrowserSession` (`src/browser.ts`) spins up a `Bun.serve()` on
`127.0.0.1:5151` (random fallback if busy), opens the OS-default browser at
`http://127.0.0.1:5151/?id=<sid>`, and serves the embedded React bundle
(`web/dist/index.html`, text-imported via `src/browser.embedded.ts`). Endpoints:

- `GET /tx?id=<sid>` — returns the `Payload` JSON: `kind` (`"tx" | "order" |
  "permit-tx"`), chain meta, tokenIn/Out meta, amountIn/Out, sender, **recipient**
  (set only for `-a send`), approval info, and exactly one of `tx` / `order` /
  `permitTx`. Validated against the random `sid` minted at startup.
- `POST /simulate?id=<sid>` — runs `eth_simulateV1` server-side via the same
  `simulateSwap` helper as `--simu`, returns `SimulateOutcomeWire` with bigints
  stringified. Only wired when there's a callable swap tx (`kind="tx"`); async /
  permit-tx return `{kind:"skipped"}`. RPC stays on the local server; no API key
  reaches the browser.
- `POST /assemble?id=<sid>` — Path A second leg: takes `{signature}`, invokes the
  per-session `assemble` callback (closure bound to the original quote +
  permitData), returns the broadcastable `NormalizedTx`. The Uniswap API key never
  leaves the local server. Only wired when `kind="permit-tx"`.
- `POST /submit?id=<sid>` — authed-order submission leg: forwards the signed order
  body to the venue's relayer with the auth header resolved from the env (fusion →
  `ONEINCH_API_KEY`). Only wired when the session's order carries `submit.auth`;
  the payload's `submit.url` is rewritten to this endpoint so `SignOrder` needs no
  changes.
- `POST /done?id=<sid>` is the terminal callback. Body is the same union the
  hosted dApp posts, `kind` of `tx` / `order` / `error` plus `venue` and
  `chainId`. It resolves the `wait()` promise so the CLI prints the result and
  exits. A body that fails `parseDoneReport` resolves `wait()` with that parse
  error and returns 400. This route writes **no** structured line. Stdout here
  belongs to the CLI, and a stray JSON line would corrupt `--json` output.

The server stops 1.5 s after `/done` (gives the browser a moment to render the
success state) or after a 10-minute hard timeout.

### Page components (`web/src/`)

`App.tsx` is the router: it loads the payload, derives a wallet-mismatch flag
(`address.toLowerCase() !== payload.sender.toLowerCase()`), and **hard-blocks**
the action component when mismatched (red panel, no button — the calldata
recipient is bound to `--from`). When matched it renders one of:

- `SendTx` (`kind="tx"`) — derives a `Mode` from `venue` + `tokenIn` (native
  sentinel check): `wrap` / `unwrap` / `send` / `swap`. Each mode tweaks panel
  labels, button text, and which rows render — slippage and spender hide for
  non-swap modes (1:1 / no allowance check). Includes the **simulate** panel that
  POSTs to `/simulate` and renders approve/swap status, gas, revert reason,
  tokenOut delta.
- `SignOrder` (`kind="order"`) — async venues. Signs `typedData` via wagmi
  `useSignTypedData`, POSTs `{...bodyTemplate, signature}` to `order.submit.url`,
  reports the orderId.
- `SignPermitTx` (`kind="permit-tx"`) — Uniswap Path A. Signs Permit2
  PermitSingle, POSTs the signature to `/assemble`, then `sendTransaction`s the
  returned tx and reports the hash.

### Wagmi config (`web/src/wagmi.ts`)

Known chains for the RainbowKit switcher: mainnet, arbitrum, base, optimism, bsc,
unichain, avalanche, hyperEvm, robinhood, monad, plasma, polygon, gnosis, ink. Transports use the
CORS-open URLs in `CORS_OPEN_RPC` (`shared/public_rpc.ts`), with the injected
wallet provider first when it sits on the selected chain. The operator Alchemy
key never reaches the browser.

### Favicon

A small SVG (terminal `>` + ETH diamond) inlined as a base64 data URI in
`web/index.html`. Files in `web/public/` would copy as separate assets and break
the single-file embed.

## Vercel target

The same dApp deploys to a serverless target (Vercel) as a static front + one
serverless function per route. See [vercel.md](./vercel.md) for the full
deployment guide (env vars, install/build commands, rewrites, public-API
warning). Technical constraints:

- `api/*.ts` are thin Web-signature functions over `src/server/handlers.ts`.
  Their import graph must stay **Bun-free** — `src/server/shared.ts` exists
  precisely to keep `browser.ts`'s text-import / `Bun.serve` out of it.
- tsconfig's **`rewriteRelativeImportExtensions` is load-bearing**: the node
  builder compiles each `.ts` file-by-file honouring tsconfig but never rewrites
  import specifiers — without the flag the emitted JS keeps `.ts` imports and
  every function dies at load (`FUNCTION_INVOCATION_FAILED`). Bun and the noEmit
  typecheck are unaffected.
- `SWAP_DISABLE_VENUES=curve` is mandatory there: curve-js's ~12s in-process
  on-chain init is incompatible with cold starts. The dispatcher lazy-loads
  `curve.ts` (dynamic import; `shutdown()` only cleans up if it was ever loaded).
- Local test bench: `SWAP_DISABLE_VENUES=curve bun run scripts/vercel-smoke.ts` —
  mounts the `api/` functions under `Bun.serve` with `vercel.json`'s rewrites
  replicated and serves `web/dist-vercel/` statically (on :5152).

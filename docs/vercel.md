# Deploying the swap dApp on Vercel

## Connect the repo

1. Import this repository on [vercel.com/new](https://vercel.com/new).
2. **Root directory** — leave as the repo root (not `web/`). `vercel.json` at the root drives everything.
3. **Framework preset** — choose **Other** (not Next.js). Vercel will pick up `installCommand` / `buildCommand` / `outputDirectory` from `vercel.json`.

`vercel.json` summary:

| field            | value                               |
|------------------|-------------------------------------|
| installCommand   | `bun install && cd web && bun install` |
| buildCommand     | `cd web && bun run build:vercel`    |
| outputDirectory  | `web/dist-vercel`                   |

The `api/*.ts` files at the repo root become serverless functions automatically; `vercel.json`'s `rewrites` map `/assemble`, `/submit`, `/done`, `/simulate`, `/tx`, and `/api/quote/stream` to the right function files.

## Environment variables

Set these in **Project → Settings → Environment Variables**:

| Variable                  | Required | Notes                                                              |
|---------------------------|----------|--------------------------------------------------------------------|
| `ALCHEMY_API_KEY`         | Optional | When set, used for allowance, decimals, and gasPrice. When unset, PublicNode |
| `SWAP_DISABLE_VENUES`     | **Mandatory** | Set to `curve` — Curve Finance initialises on-chain data in ~12s per cold start, which exceeds Vercel's function timeout |
| `WALLETCONNECT_PROJECT_ID`| Optional | Enables WalletConnect in RainbowKit; without it only injected wallets work |
| `ZEROEX_API_KEY`          | Optional | Enables the Matcha (0x) venue                                      |
| `ONEINCH_API_KEY`         | Optional | Enables the 1inch and Fusion venues                                |
| `UNISWAP_API_KEY`         | Optional | Enables Uniswap Classic and UniswapX venues                        |
| `KYBER_API_KEY`           | Optional | Switches Kyber to the API gateway (`X-Api-Key`, higher limits). Unset → public keyless host (3 rps) |
| `OPENOCEAN_API_KEY`       | Optional | Switches OpenOcean to the pro host (`apikey` header). Unset → public keyless host (2 rps) |
| `KYBER_API_BASE`          | Optional | Leave unset. Defaults: no key → `https://aggregator-api.kyberswap.com`; with `KYBER_API_KEY` → `https://api.kyberswap.com/swap`. Only set to hit a different host |
| `KYBER_SOURCE`            | Optional | On-chain `source` in Kyber's ClientData event on `/route/build`. Attribution only |
| `KYBER_REFERRAL`          | Optional | On-chain `referral` in Kyber's ClientData event. Attribution only |
| `OPHIS_REFERRAL_CODE`     | Optional | Enables the Ophis venue (CoW fork) and tags every order with your registered rebate code. Unset → Ophis is filtered out (like a missing API key) |
| `REFERRAL_ADDRESS`        | Optional | Recipient of partner fees / surplus, checksummed on load. Unset → no fee is charged on any venue |
| `REFERRAL_FEE_BPS`        | Optional | Explicit fee in basis points layered on top of `REFERRAL_ADDRESS`, 0–1000 (10%), each venue clamping further. Requires `REFERRAL_ADDRESS` to be set |
| `FUSION_FEE_ENABLED`      | Optional | Set to `1` only once 1inch has enabled integrator fees on your `ONEINCH_API_KEY`; otherwise Fusion sends `source` attribution only and any non-zero fee would be rejected with `FEE_NOT_ALLOWED` |
| `REFERRAL_NAME`           | Optional | Free-form attribution label (velora `partner`, kyber `x-client-id`, cow `appCode`, fusion `source`); the hosted dApp appends `-dapp`. Set a value distinct from the public binary's (`swap`) so dashboards can tell the channels apart. Unset → `swap-selfhost-dapp` |
| `COW_REFERRAL_CODE`       | Optional | CoW Protocol affiliate code embedded in order appData. Attribution only, does not change the quote |

`loadDotenv()` is only called from the CLI entry point (`src/index.ts`) and never runs on Vercel, so any of these left unset in the Vercel project env is simply absent: an unset `REFERRAL_ADDRESS` deploys a fee-free instance silently, with no startup error.

## Public-API warning

The Vercel deployment has **no session gate** (unlike the local `swap` CLI which guards every endpoint with a `?id=` token). Any visitor who can reach the deployment URL will trigger API calls that consume your keys' quotas.

The public `swap` CLI binary is now itself a client of this API by default (`--hosted` / `SWAP_API_URL`, see `src/remote.ts` and [architecture.md](./architecture.md#hosted-mode)): every `curl | bash` install quotes and builds through this deployment unless the user passes `--local`. Budget venue-key quotas for CLI traffic, not just dApp visitors, when sizing the deployment. The CLI enforces `GET /api/mode.apiVersion === 1` before doing anything else and refuses to run on a mismatch, so `apiVersion` in `src/server/shared.ts` must stay at `1` for as long as the wire contract (`/api/quote`, `/api/quote/stream`, `/api/build`, `/api/mode`, `/api/resolve-token` response shapes) stays backward compatible; bump it only alongside a breaking change, since every already-installed hosted binary starts failing loud (pointing at `swap update`) the moment it does.

### In-code rate limiting

`src/server/ratelimit.ts` applies a per-IP token bucket to `api/*.ts` wrappers
(`rateLimit(req, <bucket>) ?? handler(req)`). The caller IP is the first hop of
`x-forwarded-for`, else `x-real-ip`, else `unknown`. Over-limit requests get
`429` with `{"error":"rate limited, retry shortly"}` and a `Retry-After`
header, and the refusal is logged (IP + path + bucket) to the function logs.
`GET /api/icon` is exempt: the picker can request hundreds of curated-list
images in one open, and the handler does not touch venue quotas.

| Bucket   | Limit / IP | Endpoints                                                        |
|----------|-----------:|------------------------------------------------------------------|
| `quote`  |     60/min | `/api/quote`, `/api/quote/stream`, `/api/route`                   |
| `build`  |     12/min | `/api/build`, `/assemble`                                         |
| `submit` |      6/min | `/submit`                                                         |
| `light`  |    120/min | `/api/mode`, `/api/tokens`, `/api/resolve-token`, `/simulate`, `/tx`, `/done` |

Sized against the dApp's real cadence: a quote round is one stream call plus one
`/api/route` call, inputs are debounced 400 ms and re-quote on expiry (~20 s), so
a busy tab sits well under the quote limit.

**Limits of this layer** — the counters are **in-memory per instance**. Vercel
spreads traffic across instances and cold starts reset the map, so the effective
ceiling is `limit × live instances`. It bounds a single hammering client; it does
not stop a distributed one. Marked in the source as
`// ponytail: per-instance counters, upgrade to Vercel WAF or Upstash if real abuse shows up`.

The guard is a **no-op unless `process.env.VERCEL` is set**, so the local Bun
server (`src/serve.ts`) and the `--browser` bridge stay unthrottled.

Self-test: `bun run src/server/ratelimit.ts`.

### Still do this in the dashboard

The edge layer can't be configured in code — set it up on the project:

- Enable **Vercel WAF** and/or its **rate limiting** rules (blocks abuse before it reaches a function, and is shared across instances).
- Consider IP allowlisting if this is an internal tool.
- Rotate any key that gets abused; revoke the Vercel env var and redeploy.

## Framing headers (Safe App)

The catch-all header rule in `vercel.json` used to send `X-Frame-Options: DENY`
alongside `Content-Security-Policy: frame-ancestors 'none'`. Running as a Safe
App means being framed by `https://app.safe.global`, so the CSP directive now
reads `frame-ancestors 'self' https://app.safe.global` and `X-Frame-Options` is
gone entirely rather than relaxed. There is no form of that header a current
browser honours with an origin allowlist (`ALLOW-FROM` was dropped by every
engine), so keeping it at `DENY` would have overridden the CSP in the browsers
that still read it, and keeping it at all would have added nothing the CSP does
not already say. `frame-ancestors` is the allowlist, and it is strictly narrower
than the old pair was for every origin except `app.safe.global`.

`/manifest.json` gets its own rule with `Access-Control-Allow-Origin: *`, plus an
explicit JSON content type and a one-hour cache. The Safe web app fetches it
cross-origin, before it mounts the iframe, to read the app's name and icon.

## CLI one-shot install

The dApp deployment hosts the CLI installer at a stable path:

```sh
curl -fsSL https://swap.9summits.io/install.sh | bash
```

`web/public/install.sh` is copied into `web/dist-vercel/` by Vite, so
`GET /install.sh` is served as plain text.

Binaries live on Vercel Blob. `vercel.json` redirects `/cli/:path*` on the
dApp host to that store. `install.sh` and `swap update` download through
`https://swap.9summits.io/cli`. Override the base per run with
`SWAP_INSTALL_BASE`. After install, `swap update` reads the asset's `.sha256`
manifest first and only pulls the multi-MB asset — then verifies it and
atomically replaces the installed binary — when the installed binary's digest
differs.

Publish / refresh assets:

```sh
# maintainer machine: BLOB_READ_WRITE_TOKEN + .env.install, then ./deploy.sh
vercel env pull .env.blob --environment production
./deploy.sh
```

Always build with `SWAP_PUBLIC_BUILD=1`. That mode embeds **`.env.install`**
(not `.env`) into the binary — the curated keys you want every `curl|bash`
user to get (venue API keys, referral codes). Alchemy / RPC keys stay out of
the embed (users configure via first-run / `swap --init`). `.env.install` is
gitignored; publish from a machine that has the file. Personal operator
secrets stay in `.env` and are never used for install builds.

## Preview deployments

Every branch pushed to GitHub automatically gets its own Vercel preview URL (`https://<project>-<branch>-<team>.vercel.app`). Use these to test UI changes before merging to main.

## Local test (before deploying)

Run the smoke harness — it imports every `api/*.ts` function and routes requests through the same rewrites as `vercel.json`:

```sh
SWAP_DISABLE_VENUES=curve bun run scripts/vercel-smoke.ts &
sleep 2

# Interactive mode bootstrap
curl -s localhost:5152/api/mode | jq .

# Per-chain token list
curl -s 'localhost:5152/api/tokens?chain=eth' | jq 'length'

# Quote (WETH → USDT, 1 ETH)
curl -s -X POST localhost:5152/api/quote \
  -H 'content-type: application/json' \
  -d '{"chain":"eth","tokenInAddress":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","tokenOutAddress":"0xdac17f958d2ee523a2206206994597c13d831ec7","amountIn":"1000000000000000000","slippageBps":10,"allowAsync":false}' \
  | jq '{best, routes: [.routes[] | {venue, amountOut}]}'

# Same via the stream rewrite
curl -s -X POST localhost:5152/api/quote/stream \
  -H 'content-type: application/json' \
  -d '{"chain":"eth","tokenInAddress":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","tokenOutAddress":"0xdac17f958d2ee523a2206206994597c13d831ec7","amountIn":"1000000000000000000","slippageBps":10,"allowAsync":false}'

kill %1  # stop the smoke server
```

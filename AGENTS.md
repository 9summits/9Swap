# AGENTS.md — instructions for AI coding agents

This repository is **swap**: an EVM DEX meta-aggregator CLI and browser dApp that races third-party aggregator APIs, ranks quotes, and builds swap txs or EIP-712 intent orders.

For day-to-day contributor layout, commands, and non-negotiable rules, read **[CLAUDE.md](./CLAUDE.md)** and **[docs/](./docs/)**. This file focuses on **how agents should discover and treat the public product surface**.

## Public product (agent discovery)

| Resource | URL / path |
|----------|------------|
| Live dApp | https://swap.9summits.io/ |
| Compact LLM index | https://swap.9summits.io/llms.txt |
| Full LLM context (API + CLI) | https://swap.9summits.io/llms-full.txt |
| CLI manual (HTML / Markdown) | https://swap.9summits.io/docs · https://swap.9summits.io/docs.md (`/docs` honours `Accept: text/markdown`) |
| OpenAPI 3.1 for `/api/*` | https://swap.9summits.io/openapi.json |
| Installable agent skill | https://swap.9summits.io/skills/swap-cli/SKILL.md |
| robots.txt | https://swap.9summits.io/robots.txt |
| Sitemap | https://swap.9summits.io/sitemap.xml |
| CLI installer | `curl -fsSL https://swap.9summits.io/install.sh \| bash` |

Static discovery files live in **`web/public/`** (Vite copies them into `web/dist-vercel/` on the Vercel build). Keep them factual and in sync when public URLs or the API contract change.

## What this product is / is not

- **Is:** a quote + build frontend over external DEX aggregators (Kyber, Odos, Velora, 0x, 1inch, Curve, Uniswap, CoW, …).
- **Is not:** a liquidity pool, a custodial exchange, or a marketing site with blog/pricing pages.
- Source license: **Apache-2.0** (`LICENSE`, copyright in `NOTICE`) — OSI open source. The prebuilt CLI binary bundles `@ophis/sdk` (GPL-3.0-or-later), so the binary as a whole ships under GPL-3.0 terms. Install binaries are on Vercel Blob via `/cli/*`.

## When implementing features

1. Prefer **`src/core.ts` + venue adapters** over duplicating orchestration in the web layer.
2. **Decimals are safety-critical** — never coerce to 18; fail if unresolved.
3. Approval reasoning uses **`tx.spender`**, not `tx.to`.
4. Native token sentinel: `0xeee…eee` internally; lowercase addresses for comparison.
5. Same **slippage** for quote and build.
6. Async venues change semantics (sign + POST, not just broadcast) — do not mix with sync UX without an explicit allow path.
7. Public serverless API is **stateless** and **ungated** — do not add open endpoints that burn Alchemy/venue quotas (no public balances API).
8. Commit messages: **no** `Co-Authored-By: Claude` (or similar) trailers.

## HTTP API (shared local + Vercel)

Documented for agents in `llms-full.txt`. Thin Vercel wrappers: `api/*.ts` → `src/server/handlers.ts`. Rewrites in root `vercel.json` (`/assemble`, `/submit`, `/api/quote/stream`, …).

Key endpoints: `GET /api/mode`, `GET /api/tokens`, `POST /api/resolve-token`, `POST /api/quote`, `POST /api/quote/stream`, `POST /api/route`, `POST /api/build`, `POST /assemble`, `POST /submit`.

## Local verification

```sh
bun run typecheck
bun test tests/*.test.ts
bun run src/index.ts 2000 weth steth -v all   # smoke: check every comparison row
```

Web: `cd web && bun run build:vercel` (output `web/dist-vercel/`, includes `public/*`).

## Markdown for agents on the web host

The public site is a React SPA (not a docs framework); the UI route itself has no `.md` mirror. Machine-readable product context is concentrated in these `web/public/` files — keep them in sync with each other and with `swap --help`:

- `/llms.txt` — link index (llmstxt.org); `/llms-full.txt` — full prose + API surface
- `/docs.html` + `/docs.md` — the CLI manual, HTML and Markdown (same sections; `/docs` rewrites by `Accept` header in `vercel.json`)
- `/openapi.json` — OpenAPI 3.1 for every `/api/*` handler (`src/server/handlers.ts`, types in `web/src/dapp/types.ts` + `web/src/payload.ts`). Lint with `bunx @redocly/cli lint web/public/openapi.json`
- `/skills/swap-cli/SKILL.md` — installable agent skill (frontmatter `name` / `description` + instructions)

When you add a flag, venue, chain or endpoint: update `docs.html`, `docs.md`, `openapi.json`, `llms-full.txt`, and `SKILL.md` if the change affects how an agent should drive the CLI. The venue × chain availability matrix (README, `docs.html`, `docs.md`, `llms-full.txt`) is hand-derived from each adapter's supported-chain set — regenerate it whenever one of those sets or `src/chains.ts` changes.

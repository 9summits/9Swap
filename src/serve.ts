// `swap` with no arguments launches this: a long-lived local server that
// serves the interactive 9Summits swap dApp and exposes the CLI's quote /
// build / token machinery as JSON `/api/*` endpoints. Unlike browser.ts
// (one pre-built quote, sign-and-send, auto-closes), this is a multi-quote
// interactive session that stays up until the user Ctrl-C's it.
//
// As of the Vercel refactor, ALL endpoint logic lives in the STATELESS
// handlers in `src/server/handlers.ts` (shared with the `api/*.ts` Vercel
// functions). This file is now just the Bun-side scaffolding: the long-lived
// Bun.serve(), the ?id= session gate, the static-bundle route, browser open,
// and SIGINT/SIGTERM teardown (curve's worker/provider). There is no more
// server-side state (no quote cache, no pendingPermit, no pendingOrder) —
// the stateless handlers reconstruct everything from each request body, so
// the dApp behaves identically whether it runs here or on Vercel.
//
// The frontend (web/) is ONE bundle, two modes: it calls GET /api/mode; an
// interactive response renders the dApp, otherwise it falls back to the
// legacy sign-only page that browser.ts serves.

import { randomBytes } from "node:crypto";
import { EMBEDDED_INDEX_HTML } from "./browser.embedded.ts";
import { openBrowser } from "./browser.ts";
import { shutdown } from "./venues/index.ts";
import {
  handleMode,
  handleTxProbe,
  handleTokens,
  handleIcon,
  handleResolveToken,
  handleQuote,
  handleQuoteStream,
  handleRoute,
  handleBuild,
  handleAssemble,
  handleSubmit,
  handleSimulate,
  handleDone,
} from "./server/handlers.ts";

const DEFAULT_PORT = 5151;

export type ServeOptions = { port?: number; noOpen?: boolean };

// Static discovery / docs files served by the public host only (web/public).
const HOSTED_STATIC_PATHS = new Set([
  "/docs",
  "/docs.html",
  "/docs.md",
  "/terms.html",
  "/llms.txt",
  "/llms-full.txt",
  "/openapi.json",
  "/skills/swap-cli/SKILL.md",
]);

export async function startServeSession(opts: ServeOptions = {}): Promise<void> {
  // SWAP_SID pins the session token across restarts (hosted/Docker deployments
  // where the ?id=… link doubles as the access credential and must stay stable).
  const sid = process.env.SWAP_SID || randomBytes(8).toString("hex");
  // SWAP_NO_AUTH=1 disables the ?id= session gate entirely (clean URLs for
  // hosted deployments). Anyone who can reach the server can then use it —
  // pair with an upstream lock (nginx basic_auth, VPN, IP allowlist).
  const noAuth = process.env.SWAP_NO_AUTH === "1";

  const auth = (url: URL) => noAuth || url.searchParams.get("id") === sid;

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── static bundle ──
    if (path === "/" && req.method === "GET") {
      return new Response(EMBEDDED_INDEX_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // The footer's Docs / Terms links and the agent-discovery files. These
    // static files live in web/public and are not embedded in the binary —
    // redirect to the hosted copies instead of 404ing.
    if (HOSTED_STATIC_PATHS.has(path) && req.method === "GET")
      return Response.redirect(`https://swap.9summits.io${path}`, 302);

    // Icons are loaded via <img src> without the session id, and only ever
    // serve whitelisted token images from the curated list — exempt from the
    // sid gate. Handled before the gate below.
    if (path === "/api/icon" && req.method === "GET") return handleIcon(req);

    // Everything below is session-gated.
    if (
      path.startsWith("/api/") ||
      path === "/done" ||
      path === "/assemble" ||
      path === "/simulate" ||
      path === "/submit" ||
      path === "/tx"
    ) {
      if (!auth(url)) return new Response("forbidden", { status: 403 });
    }

    // ── all endpoint logic delegates to the stateless shared handlers ──
    if (path === "/api/mode" && req.method === "GET") return handleMode({ sid });
    if (path === "/tx" && req.method === "GET") return handleTxProbe();
    if (path === "/api/tokens" && req.method === "GET") return handleTokens(req);
    if (path === "/api/resolve-token" && req.method === "POST") return handleResolveToken(req);
    if (path === "/api/quote/stream" && req.method === "POST") return handleQuoteStream(req);
    if (path === "/api/quote" && req.method === "POST") return handleQuote(req);
    if (path === "/api/route" && req.method === "POST") return handleRoute(req);
    if (path === "/api/build" && req.method === "POST") return handleBuild(req, { sid });
    if (path === "/assemble" && req.method === "POST") return handleAssemble(req);
    if (path === "/submit" && req.method === "POST") return handleSubmit(req);
    if (path === "/simulate" && req.method === "POST") return handleSimulate();
    if (path === "/done" && req.method === "POST") return handleDone(req);

    return new Response("not found", { status: 404 });
  }

  let server: ReturnType<typeof Bun.serve>;
  const preferredPort = opts.port ?? DEFAULT_PORT;
  // SWAP_HOST widens the bind for containerized deployments (an nginx sidecar
  // can't reach another container's loopback). Default stays loopback-only.
  const hostname = process.env.SWAP_HOST || "127.0.0.1";
  try {
    // idleTimeout: the NDJSON quote stream can sit >10s (Bun's default)
    // between two venue lines when a slow venue holds the round — the default
    // would sever the response mid-stream (ERR_INCOMPLETE_CHUNKED_ENCODING).
    server = Bun.serve({ hostname, port: preferredPort, fetch: handle, idleTimeout: 120 });
  } catch {
    server = Bun.serve({ hostname, port: 0, fetch: handle, idleTimeout: 120 });
  }

  const sessionUrl = noAuth
    ? `http://127.0.0.1:${server.port}/`
    : `http://127.0.0.1:${server.port}/?id=${sid}`;
  console.error(`\n  9Summits swap dApp → ${sessionUrl}`);
  if (noAuth) console.error(`  ⚠ SWAP_NO_AUTH=1 — session gate disabled, anyone reaching this server can use it`);
  console.error(`  (interactive aggregator; press Ctrl-C to stop)\n`);
  if (!opts.noOpen && !process.env.NO_BROWSER_OPEN) openBrowser(sessionUrl);

  // Stay up until the user kills it. SIGINT tears down curve's worker /
  // provider (which would otherwise keep the loop alive) and exits clean.
  await new Promise<void>((resolve) => {
    const stop = () => {
      console.error("\n  shutting down…");
      server.stop(true);
      shutdown().finally(() => resolve());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

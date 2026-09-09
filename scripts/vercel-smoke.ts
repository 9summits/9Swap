// Local smoke-test harness for the Vercel serverless functions.
//
// Imports every api/*.ts module and routes incoming requests by pathname,
// replicating the rewrites from vercel.json so the functions can be tested
// independently of Bun's serve.ts / the real Vercel runtime.
//
// The harness itself uses Bun.serve — it is LOCAL ONLY. The api/ files and
// src/server/handlers.ts deliberately contain no Bun.* calls so Vercel's
// Node runtime can run them.
//
// It also serves the built Vercel SPA from web/dist-vercel/ (run
// `bun run build:vercel` in web/ first), so the in-browser curve client can be
// exercised end-to-end against this harness exactly as it would on Vercel.
//
// Usage:
//   SWAP_DISABLE_VENUES=curve bun run scripts/vercel-smoke.ts
//   # Then open http://127.0.0.1:5152/ in a browser, or in another terminal:
//   curl -s localhost:5152/api/mode
//   curl -s localhost:5152/                # → index.html
//   curl -sI localhost:5152/assets/<chunk> # → application/javascript
//   curl -s 'localhost:5152/api/tokens?chain=eth'
//   curl -s -X POST localhost:5152/api/quote \
//     -H 'content-type: application/json' \
//     -d '{"chain":"eth","tokenInAddress":"0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","tokenOutAddress":"0xdac17f958d2ee523a2206206994597c13d831ec7","amountIn":"1000000000000000000","slippageBps":10,"allowAsync":false}'

import * as apiMode          from "../api/mode.ts";
import * as apiTokens        from "../api/tokens.ts";
import * as apiResolveToken  from "../api/resolve-token.ts";
import * as apiQuote         from "../api/quote.ts";
import * as apiQuoteStream   from "../api/quote-stream.ts";
import * as apiRoute         from "../api/route.ts";
import * as apiBuild         from "../api/build.ts";
import * as apiAssemble      from "../api/assemble.ts";
import * as apiSubmit        from "../api/submit.ts";
import * as apiSimulate      from "../api/simulate.ts";
import * as apiDone          from "../api/done.ts";
import * as apiTx            from "../api/tx.ts";
import { join, normalize } from "node:path";

const PORT = 5152;

// Static root for the Vercel-mode SPA. `bun run build:vercel` (in web/) emits
// dist-vercel/{index.html, favicon.svg, assets/*}. Serving it here makes the
// harness the full local stand-in for the Vercel deployment: GET / → index.html,
// GET /assets/* → the hashed chunks (incl. the lazy @curvefi/api chunk), so the
// in-browser curve client can actually load + init against a public RPC.
const STATIC_ROOT = join(import.meta.dir, "..", "web", "dist-vercel");

// Minimal extension → content-type map. The build only emits .html/.js/.css/
// .svg; everything else falls back to octet-stream.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Serve a file from dist-vercel. `urlPath` is the request pathname ("/" maps to
// index.html). normalize() + the STATIC_ROOT prefix guard block "../" escapes.
// Returns null when the file doesn't exist so the caller can 404 / fall back.
async function serveStatic(urlPath: string): Promise<Response | null> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const abs = normalize(join(STATIC_ROOT, rel));
  // Path-traversal guard: the resolved path must stay under STATIC_ROOT.
  if (!abs.startsWith(STATIC_ROOT)) return null;
  const file = Bun.file(abs);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: { "content-type": contentTypeFor(abs) },
  });
}

// Replicate the rewrites from vercel.json so stream / legacy endpoints
// resolve to the same function as on real Vercel.
function applyRewrites(pathname: string): string {
  if (pathname === "/api/quote/stream") return "/api/quote-stream";
  if (pathname === "/assemble")         return "/api/assemble";
  if (pathname === "/submit")           return "/api/submit";
  if (pathname === "/done")             return "/api/done";
  if (pathname === "/simulate")         return "/api/simulate";
  if (pathname === "/tx")               return "/api/tx";
  return pathname;
}

async function handle(req: Request): Promise<Response> {
  const url    = new URL(req.url);
  const path   = applyRewrites(url.pathname);
  const method = req.method;

  if (path === "/api/mode"           && method === "GET")  return apiMode.GET(req);
  if (path === "/api/tokens"         && method === "GET")  return apiTokens.GET(req);
  if (path === "/api/resolve-token"  && method === "POST") return apiResolveToken.POST(req);
  if (path === "/api/quote"          && method === "POST") return apiQuote.POST(req);
  if (path === "/api/quote-stream"   && method === "POST") return apiQuoteStream.POST(req);
  if (path === "/api/route"          && method === "POST") return apiRoute.POST(req);
  if (path === "/api/build"          && method === "POST") return apiBuild.POST(req);
  if (path === "/api/assemble"       && method === "POST") return apiAssemble.POST(req);
  if (path === "/api/submit"         && method === "POST") return apiSubmit.POST(req);
  if (path === "/api/simulate"       && method === "POST") return apiSimulate.POST(req);
  if (path === "/api/done"           && method === "POST") return apiDone.POST(req);
  if (path === "/api/tx"             && method === "GET")  return apiTx.GET(req);

  // Anything that isn't an API route → static file from dist-vercel (GET/HEAD
  // only). This makes the harness serve the full Vercel SPA: GET / →
  // index.html, GET /assets/* → the hashed JS/CSS chunks (with the right
  // content-types), GET /favicon.svg, etc.
  if (method === "GET" || method === "HEAD") {
    const stat = await serveStatic(url.pathname);
    if (stat) return stat;
    // SPA fallback: unknown non-asset GET paths resolve to index.html so client
    // routing works (no deep links in this dApp, but mirrors Vercel's rewrite).
    if (!url.pathname.startsWith("/assets/") && !url.pathname.startsWith("/api/")) {
      const index = await serveStatic("/");
      if (index) return index;
    }
  }

  return new Response("not found", { status: 404 });
}

// idleTimeout: keep slow venue streams alive (see serve.ts) — Bun's 10s
// default severs the NDJSON quote stream between two venue lines.
const server = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: handle, idleTimeout: 120 });
console.log(`vercel-smoke listening on http://127.0.0.1:${server.port}`);

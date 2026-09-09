// Vercel serverless entry points for the interactive swap dApp.
//
// These 12 functions are the Vercel surface of src/server/handlers.ts.
// The local Bun server (src/serve.ts) mounts the same handlers — one
// implementation, two runtimes. Each file is a thin wrapper: import the
// handler, export the HTTP verb function Vercel expects.
//
// No `Bun.*` anywhere in this file or in src/server/handlers.ts.
//
// Most wrappers open with `rateLimit(req, <bucket>) ?? handler(req)` — the
// per-IP guard for this public surface (src/server/ratelimit.ts). It is inert
// off Vercel, so src/serve.ts and --browser keep their unthrottled handlers.
// Exception: `api/icon.ts` skips the guard (hundreds of <img> loads per
// picker open, whitelist-only, no venue quota).

import { handleMode } from "../src/server/handlers.ts";
import { rateLimit } from "../src/server/ratelimit.ts";

export async function GET(req: Request): Promise<Response> {
  return rateLimit(req, "light") ?? handleMode();
}

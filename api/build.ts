import { handleBuild } from "../src/server/handlers.ts";
import { rateLimit } from "../src/server/ratelimit.ts";

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  // No `opts` on Vercel — no session gate, no sid.
  return rateLimit(req, "build") ?? handleBuild(req);
}

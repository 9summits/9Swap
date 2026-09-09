import { handleResolveToken } from "../src/server/handlers.ts";
import { rateLimit } from "../src/server/ratelimit.ts";

export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  return rateLimit(req, "light") ?? handleResolveToken(req);
}

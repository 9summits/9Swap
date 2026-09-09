import { handleTokens } from "../src/server/handlers.ts";
import { rateLimit } from "../src/server/ratelimit.ts";

export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  return rateLimit(req, "light") ?? handleTokens(req);
}

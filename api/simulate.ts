import { handleSimulate } from "../src/server/handlers.ts";
import { rateLimit } from "../src/server/ratelimit.ts";

export async function POST(req: Request): Promise<Response> {
  return rateLimit(req, "light") ?? handleSimulate();
}

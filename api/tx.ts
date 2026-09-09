import { handleTxProbe } from "../src/server/handlers.ts";
import { rateLimit } from "../src/server/ratelimit.ts";

export async function GET(req: Request): Promise<Response> {
  return rateLimit(req, "light") ?? handleTxProbe();
}

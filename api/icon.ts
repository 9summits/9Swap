import { handleIcon } from "../src/server/handlers.ts";

export const maxDuration = 15;

// Not rate-limited. The token picker can request hundreds of images in one
// open, and this handler only serves logos from the curated list (no venue
// quota). The 120/min `light` bucket was 429ing the tail, which made
// TokenIcon walk 1inch/TrustWallet and look like a reload on every visit.
export async function GET(req: Request): Promise<Response> {
  return handleIcon(req);
}

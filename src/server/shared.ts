// Bun-free helpers shared between the local servers (`src/serve.ts`,
// `src/browser.ts`, both Bun.serve) and the Vercel serverless functions
// (`api/*.ts`, Node/Web-API runtime). NOTHING here may reference `Bun.*`,
// `Bun.serve`, `Bun.spawn`, or a Bun text-import — those would break the
// Node build that Vercel performs on the functions importing this module.
//
// browser.ts re-exports the symbols defined here so its existing consumers
// (serve.ts, index.ts) keep their import sites unchanged.

import type {
  NormalizedOrder,
  NormalizedPermitTx,
  NormalizedQuote,
  NormalizedTx,
} from "../venues/index.ts";

// Version of the `/api/*` wire contract, advertised by GET /api/mode as
// `apiVersion`. Non-browser clients (the CLI's hosted mode) read it to decide
// whether a deployment is new enough to serve the fields they need — a page
// served from an older deployment omits the key entirely, which reads as
// "pre-versioning" (i.e. no hops / router / tokenHints on route rows).
// Bump ONLY on a breaking or field-adding change to the contract; additive
// changes that every consumer already tolerates don't need one.
export const API_VERSION = 1;

// Shape served by GET /tx?id=… — must match `web/src/payload.ts`.
export type ApprovalForBrowser = {
  needed: boolean;
  current: string;
  required: string;
  approveTx:
    | (Pick<
        NormalizedTx,
        | "to"
        | "from"
        | "data"
        | "value"
        | "gas"
        | "gasPrice"
        | "maxPriorityFeePerGas"
        | "spender"
        | "chainId"
      > & { from: string })
    | null;
};

export type Payload = {
  kind: "tx" | "order" | "permit-tx";
  venue: string;
  chain: {
    chainId: number;
    name: string;
    explorer: string;
    nativeSymbol: string;
  };
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  amountIn: string;
  amountOut: string;
  minAmountOut?: string;
  sender: string;
  // Recipient address for `-a send` actions; null otherwise. The page
  // uses this to show "send to <recipient>" instead of the swap labels,
  // since for ERC20 sends the recipient is buried in tx.data and the
  // user-facing destination matters more than the calldata target.
  recipient: string | null;
  slippageBps: number;
  simulateEnabled: boolean;
  approval: ApprovalForBrowser | null;
  tx: (NormalizedTx & { from: string }) | null;
  order: NormalizedOrder | null;
  permitTx: NormalizedPermitTx | null;
  // Opaque context echoed back to /assemble for the stateless permit-tx leg.
  // On Vercel there is no server-side `pendingPermit`, so the build response
  // carries the {venue, chain, sender, quote} the assemble step needs (with
  // bigints stringified). The local serve.ts also sets it for parity, though
  // it could equally rely on its in-process pendingPermit.
  assembleContext?: unknown;
  walletConnectProjectId: string | null;
};

// Orders whose relayer requires an auth header (fusion → 1inch Bearer key)
// can't be POSTed from the page: the key must stay server-side and the
// relayer doesn't answer CORS preflights anyway. Rewrite the submit target
// to the local /submit endpoint (strips `auth`); the server forwards with
// the real header attached. SignOrder POSTs submit.url verbatim, so the
// relative URL resolves against the page origin — i.e. right back here.
//
// venue / chainId / orderHash are encoded into the URL so the STATELESS
// /submit handler (Vercel) can reconstruct the relayer target entirely
// server-side without trusting any client-supplied URL. The stateful
// one-shot --browser /submit (which keeps the order in a closure) ignores
// these extra params, so it stays correct too.
export function rewriteAuthedOrderSubmit(
  order: NormalizedOrder,
  sid: string,
): NormalizedOrder {
  if (!order.submit.auth) return order;
  const qs = new URLSearchParams({
    id: sid,
    venue: order.venue,
    chainId: String(order.chainId),
    orderHash: order.orderHash ?? "",
  });
  return {
    ...order,
    submit: {
      url: `/submit?${qs.toString()}`,
      method: order.submit.method,
      bodyTemplate: order.submit.bodyTemplate,
    },
  };
}

// Server-side leg of the authed-order submission: forward the signed body
// to the venue's relayer with the auth header resolved from the env. Uses
// only `fetch` and the Web `Response` — safe in both Bun and Node.
export async function proxyOrderSubmit(
  order: NormalizedOrder,
  body: string,
): Promise<Response> {
  const sub = order.submit;
  const auth = sub.auth;
  if (!auth) {
    return Response.json(
      { error: "order has no submit auth — nothing to proxy" },
      { status: 400 },
    );
  }
  const key = process.env[auth.envVar];
  if (!key) {
    return Response.json(
      { error: `${auth.envVar} is not set — cannot submit to ${sub.url}` },
      { status: 500 },
    );
  }
  try {
    const authHeader: Record<string, string> =
      auth.kind === "api-key"
        ? { "x-api-key": key }
        : { authorization: `Bearer ${key}` };
    const upstream = await fetch(sub.url, {
      method: sub.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...authHeader,
      },
      body,
      // Never chase redirects with the Bearer key attached — a 3xx from the
      // relayer would otherwise resend the key to whatever host it points at.
      // Relayers answer 2xx/4xx directly; a redirect here is unexpected and
      // surfaces below as a non-2xx error the caller can read.
      redirect: "manual",
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(
        `order submit proxy: ${sub.url} → ${upstream.status} ${upstream.statusText}: ${text.slice(0, 300)}`,
      );
      return new Response(text || upstream.statusText, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/plain",
        },
      });
    }
    // Some relayers (1inch) return 201 with an empty body. Surface the
    // client-computed order hash so the page has an id to display/report.
    if (!text.trim()) {
      return Response.json({ orderId: order.orderHash ?? "submitted" });
    }
    return new Response(text, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    console.error(`order submit proxy: ${sub.url} failed: ${(e as Error).message}`);
    return Response.json(
      { error: (e as Error).message ?? "submit proxy failed" },
      { status: 502 },
    );
  }
}

// Ensure a built tx carries a concrete `from` (some adapters leave it null;
// the renderer / wallet wants the sender). Pure data, no Bun dependency.
export function withFromFallback(
  tx: NormalizedTx,
  sender: string,
): NormalizedTx & { from: string } {
  return { ...tx, from: tx.from ?? sender };
}

// Re-export the permit-tx type so consumers that previously pulled it from
// browser.ts can keep doing so via the re-export chain.
export type { NormalizedPermitTx };

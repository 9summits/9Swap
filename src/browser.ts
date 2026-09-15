import { randomBytes } from "node:crypto";
import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedOrder,
  NormalizedPermitTx,
  NormalizedQuote,
  NormalizedTx,
} from "./venues/index.ts";
import type { Token } from "./tokens.ts";
import { EMBEDDED_INDEX_HTML } from "./browser.embedded.ts";
import {
  rewriteAuthedOrderSubmit,
  proxyOrderSubmit,
  withFromFallback,
  type ApprovalForBrowser,
  type Payload,
} from "./server/shared.ts";
import { parseDoneReport } from "./server/done_report.ts";
import { cliClientHeaders, remoteSubmitUrl } from "./remote.ts";

// The Bun-free helpers + wire types live in src/server/shared.ts so the
// Vercel functions (Node runtime) can import them without dragging in this
// module's Bun.serve / Bun.spawn / text-import. Re-exported here so the
// existing consumers (serve.ts, index.ts) keep their import sites unchanged.
export {
  rewriteAuthedOrderSubmit,
  proxyOrderSubmit,
  withFromFallback,
} from "./server/shared.ts";
export type { ApprovalForBrowser, Payload } from "./server/shared.ts";

export type BrowserOutcome =
  | { kind: "tx-hash"; hash: string }
  | { kind: "order-id"; orderId: string }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

// JSON-safe wire shape for /simulate. Bigints get serialized as decimal
// strings since JSON.stringify can't handle them; the page can re-parse
// or just display them. Per-token USD prices (per single token, not for
// amountIn) are included so the page can render the "you sent X ≈ $Y"
// row without making its own price API call.
export type SimulateOutcomeWire =
  | {
      kind: "ok";
      approveStatus: "ok" | "reverted" | "skipped";
      approveGasUsed: string | null;
      swapStatus: "ok" | "reverted";
      swapGasUsed: string | null;
      swapRevertReason: string | null;
      tokenOutReceived: string;
      tokenInPriceUsd: number | null;
      tokenOutPriceUsd: number | null;
    }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

export type BrowserInputs = {
  venue: string;
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  quote: NormalizedQuote;
  amountIn: bigint;
  sender: string;
  recipient: string | null;
  slippageBps: number;
  // True when the user invoked the CLI with --simulate. Threads through
  // to the page so the simulate panel only renders when explicitly
  // asked for (otherwise the browser UI stays focused on send/sign).
  simulateEnabled: boolean;
  tx: NormalizedTx | null;
  order: NormalizedOrder | null;
  permitTx: NormalizedPermitTx | null;
  // Server-side callback that converts a user-provided EIP-712 signature
  // into a broadcastable tx. Only set when permitTx is non-null. The
  // page POSTs the signature to /assemble, the local server invokes
  // this, and returns the tx as JSON. Keeps the venue's API key (e.g.
  // UNISWAP_API_KEY) out of the browser context.
  assemble: ((signature: string) => Promise<NormalizedTx>) | null;
  // Server-side eth_simulateV1 — pranks tokenIn balance, runs approve +
  // swap inside one batch, returns the tokenOut received and gas used.
  // Only wired when we have a callable swap tx (kind=tx) — async
  // venues and permit-tx hand back nothing to simulate.
  simulate: (() => Promise<SimulateOutcomeWire>) | null;
  approval:
    | {
        current: bigint;
        needed: bigint;
        sufficient: boolean;
        approveTx: NormalizedTx | null;
      }
    | null;
  // Hosted mode: base URL of the `/api/*` deployment that produced `tx` /
  // `order` / `permitTx`. When set, this server stops being an executor and
  // becomes a same-origin proxy for the two legs the page can't call itself —
  // `/assemble` and `/submit` — because the page is served from 127.0.0.1 and
  // the hosted API sends no CORS headers. No local key or RPC is involved:
  // hosted builds never produce a local `assemble` callback.
  remoteBase?: string;
  // Opaque context the hosted build handed back for the stateless permit-tx
  // leg; echoed to the page so it can send it back on /assemble.
  assembleContext?: unknown;
};

export type BrowserOptions = {
  // Force a specific port; otherwise we try DEFAULT_PORT and fall back
  // to a random one if it's busy.
  port?: number;
  // Hard wall — the server stops accepting after this many ms even if
  // the browser never reports back. Default 10 minutes.
  timeoutMs?: number;
  // Don't actually open a browser; useful for tests + sanity checks.
  // The caller can hit the printed URL manually.
  noOpen?: boolean;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// Pinning a default port keeps the page origin stable across invocations
// so RainbowKit's localStorage-scoped wallet session persists. If this
// port is already in use (another swap running, port squatted), we fall
// back to the kernel-assigned port and the user just reconnects.
const DEFAULT_PORT = 5151;

export type BrowserSession = {
  url: string;
  // Resolves when the page POSTs /done or the timer fires.
  wait: () => Promise<BrowserOutcome>;
};

export function startBrowserSession(
  inputs: BrowserInputs,
  opts: BrowserOptions = {},
): BrowserSession {
  const sid = randomBytes(8).toString("hex");
  const payload = buildPayload(sid, inputs);

  let resolveOutcome: (o: BrowserOutcome) => void = () => {};
  const outcomePromise = new Promise<BrowserOutcome>((r) => {
    resolveOutcome = r;
  });

  // Try the stable default port first; fall back to kernel-assigned on
  // conflict. Bun.serve throws synchronously on EADDRINUSE.
  const fetchHandler = async (req: Request): Promise<Response> => {
    return handleRequest(req);
  };
  let server: ReturnType<typeof Bun.serve>;
  const preferredPort = opts.port ?? DEFAULT_PORT;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: preferredPort,
      fetch: fetchHandler,
    });
  } catch {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: fetchHandler,
    });
  }

  async function handleRequest(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(EMBEDDED_INDEX_HTML, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname === "/tx" && req.method === "GET") {
        if (url.searchParams.get("id") !== sid) {
          return new Response("forbidden", { status: 403 });
        }
        return Response.json(payload, {
          headers: { "cache-control": "no-store" },
        });
      }

      if (url.pathname === "/simulate" && req.method === "POST") {
        if (url.searchParams.get("id") !== sid) {
          return new Response("forbidden", { status: 403 });
        }
        if (!inputs.simulate) {
          return Response.json(
            {
              kind: "skipped",
              reason: "no callable swap tx — async/permit-tx venues can't be simulated at quote time",
            } satisfies SimulateOutcomeWire,
          );
        }
        try {
          const outcome = await inputs.simulate();
          return Response.json(outcome, {
            headers: { "cache-control": "no-store" },
          });
        } catch (e) {
          return Response.json(
            {
              kind: "error",
              message: (e as Error).message ?? "simulate failed",
            } satisfies SimulateOutcomeWire,
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/submit" && req.method === "POST") {
        if (url.searchParams.get("id") !== sid) {
          return new Response("forbidden", { status: 403 });
        }
        if (inputs.remoteBase && inputs.order) {
          // Hosted: the relayer key lives on the deployment, not here. Forward
          // the signed body and the server-minted query (venue / chainId /
          // orderHash) to the hosted /submit; drop our local session id.
          const target = new URL(
            remoteSubmitUrl(inputs.remoteBase, inputs.order),
          );
          for (const [k, v] of url.searchParams) {
            if (k !== "id") target.searchParams.set(k, v);
          }
          return proxyToRemote(target, req);
        }
        if (!inputs.order?.submit.auth) {
          return Response.json(
            { error: "/submit called but this order's relayer needs no proxying — POST submit.url directly" },
            { status: 400 },
          );
        }
        return proxyOrderSubmit(inputs.order, await req.text());
      }

      if (url.pathname === "/assemble" && req.method === "POST") {
        if (url.searchParams.get("id") !== sid) {
          return new Response("forbidden", { status: 403 });
        }
        if (inputs.remoteBase) {
          // Hosted: the venue API key lives on the deployment. Forward
          // {signature, context} verbatim — the page already echoes back the
          // assembleContext the hosted build gave it.
          const target = new URL(joinBase(inputs.remoteBase, "/assemble"));
          return proxyToRemote(target, req);
        }
        if (!inputs.assemble) {
          return Response.json(
            { error: "/assemble called but no assemble callback was provided (this venue does not produce a permit-tx)" },
            { status: 400 },
          );
        }
        try {
          const body = (await req.json()) as { signature?: string };
          if (!body.signature) {
            return Response.json(
              { error: "/assemble missing 'signature' field" },
              { status: 400 },
            );
          }
          const tx = await inputs.assemble(body.signature);
          return Response.json(
            { tx: { ...tx, from: tx.from ?? inputs.sender } },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (e) {
          return Response.json(
            { error: (e as Error).message ?? "assemble failed" },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/done" && req.method === "POST") {
        if (url.searchParams.get("id") !== sid) {
          return new Response("forbidden", { status: 403 });
        }
        try {
          const parsed = parseDoneReport(await req.json());
          if (!parsed.ok) {
            resolveOutcome({
              kind: "error",
              message: `/done parse failed: ${parsed.reason}`,
            });
            return new Response("bad json", { status: 400 });
          }
          const report = parsed.report;
          if (report.kind === "tx") {
            resolveOutcome({ kind: "tx-hash", hash: report.hash });
          } else if (report.kind === "order") {
            resolveOutcome({ kind: "order-id", orderId: report.orderId });
          } else {
            resolveOutcome({ kind: "error", message: report.error });
          }
          return new Response("ok");
        } catch (e) {
          resolveOutcome({
            kind: "error",
            message: `/done parse failed: ${(e as Error).message}`,
          });
          return new Response("bad json", { status: 400 });
        }
      }

      return new Response("not found", { status: 404 });
  }

  const port = server.port;
  const sessionUrl = `http://127.0.0.1:${port}/?id=${sid}`;

  const timer = setTimeout(() => {
    resolveOutcome({ kind: "timeout" });
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Honor NO_BROWSER_OPEN as an env-driven escape hatch — useful for the
  // CI smoke test that drives /done by hand, and for users on headless
  // boxes who'd rather copy the URL than have us probe `xdg-open`.
  if (!opts.noOpen && !process.env.NO_BROWSER_OPEN) {
    openBrowser(sessionUrl);
  }

  const wait = async (): Promise<BrowserOutcome> => {
    const outcome = await outcomePromise;
    clearTimeout(timer);
    // Give the browser a brief moment to render the success state before
    // we yank the server out from under it.
    setTimeout(() => server.stop(true), 1500);
    return outcome;
  };

  return { url: sessionUrl, wait };
}

// Back-compat thin wrapper.
export async function serveAndOpen(
  inputs: BrowserInputs,
  opts: BrowserOptions = {},
): Promise<{ outcome: BrowserOutcome; url: string }> {
  const session = startBrowserSession(inputs, opts);
  const outcome = await session.wait();
  return { outcome, url: session.url };
}

// Join a hosted base (possibly path-prefixed) with an absolute-rooted path.
function joinBase(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

// Same-origin proxy for the two hosted legs the page cannot call directly
// (the API sends no CORS headers). Only the body and the server-minted query
// travel; no local header, cookie, or key is attached.
async function proxyToRemote(target: URL, req: Request): Promise<Response> {
  const body = await req.text();
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        ...cliClientHeaders(),
        accept: "application/json",
        "content-type":
          req.headers.get("content-type") ?? "application/json",
      },
      body,
      redirect: "manual",
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(
        `hosted proxy: ${target.pathname} → ${upstream.status} ${upstream.statusText}: ${text.slice(0, 300)}`,
      );
    }
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e) {
    console.error(`hosted proxy: ${target.href} failed: ${(e as Error).message}`);
    return Response.json(
      { error: (e as Error).message ?? "hosted proxy failed" },
      { status: 502 },
    );
  }
}

// Hosted orders come back with the submit URL already rewritten by the
// deployment to a relative `/submit?venue=…` (auth stripped). Re-attach our
// local session id so the page's POST still passes this server's sid gate
// before we forward it upstream.
function withSessionId(order: NormalizedOrder, sid: string): NormalizedOrder {
  const url = order.submit.url;
  if (!url.startsWith("/")) return order;
  const q = url.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));
  params.set("id", sid);
  return {
    ...order,
    submit: {
      ...order.submit,
      url: `${q === -1 ? url : url.slice(0, q)}?${params.toString()}`,
    },
  };
}

// Build the JSON payload the page fetches. We strip a couple of bigint
// instances and pass the approval / tx as the renderer expects.
function buildPayload(sid: string, i: BrowserInputs): Payload {
  return {
    kind: i.tx ? "tx" : i.permitTx ? "permit-tx" : "order",
    venue: i.venue,
    chain: {
      chainId: i.chain.chainId,
      name: i.chain.displayName,
      explorer: i.chain.explorer,
      nativeSymbol: i.chain.nativeSymbol,
    },
    tokenIn: {
      address: i.tokenIn.address,
      symbol: i.tokenIn.symbol,
      decimals: i.tokenIn.decimals,
    },
    tokenOut: {
      address: i.tokenOut.address,
      symbol: i.tokenOut.symbol,
      decimals: i.tokenOut.decimals,
    },
    amountIn: i.amountIn.toString(),
    amountOut: i.quote.amountOut,
    ...(i.quote.minAmountOut ? { minAmountOut: i.quote.minAmountOut } : {}),
    sender: i.sender,
    recipient: i.recipient,
    slippageBps: i.slippageBps,
    simulateEnabled: i.simulateEnabled,
    approval: i.approval
      ? {
          needed: !i.approval.sufficient,
          current: i.approval.current.toString(),
          required: i.approval.needed.toString(),
          approveTx: i.approval.approveTx
            ? withFromFallback(i.approval.approveTx, i.sender)
            : null,
        }
      : null,
    tx: i.tx ? withFromFallback(i.tx, i.sender) : null,
    order: i.order
      ? i.remoteBase
        ? withSessionId(i.order, sid)
        : rewriteAuthedOrderSubmit(i.order, sid)
      : null,
    permitTx: i.permitTx,
    ...(i.assembleContext !== undefined
      ? { assembleContext: i.assembleContext }
      : {}),
    walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID ?? null,
  };
}

// Cross-platform opener. Falls back silently if the OS launcher fails
// (the user can copy the URL from stdout). All three branches use a
// system command that's preinstalled on a typical Mac/Linux/Windows
// install — no new dependencies.
export function openBrowser(url: string): void {
  let cmd: string[];
  switch (process.platform) {
    case "darwin":
      cmd = ["open", url];
      break;
    case "win32":
      cmd = ["cmd", "/c", "start", "", url];
      break;
    default:
      cmd = ["xdg-open", url];
      break;
  }
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    // openBrowser is best-effort; log and continue. The caller already
    // prints the URL on stdout so the user can paste it themselves.
    console.warn(
      `failed to launch browser via ${cmd.join(" ")}: ${(e as Error).message}`,
    );
  }
}

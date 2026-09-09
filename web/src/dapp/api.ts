// Typed fetch helpers for the interactive dApp's /api/* endpoints.
//
// Every endpoint takes ?id=<sid>, read from the URL exactly like the legacy
// web/src/api.ts sessionId() does. The execution leg (reportDone,
// assemblePermitTx, simulate) is REUSED from web/src/api.ts unchanged — once
// /api/build hands back a Payload, the existing SendTx/SignOrder/SignPermitTx
// components drive approve/sign/send and report via /done.

import { sessionId } from "../api";
import type {
  ApiMode,
  BuildPayload,
  BuildRequest,
  QuoteRequest,
  QuoteResponse,
  QuoteStreamEvent,
  RouteGraphResponse,
  RouteRequest,
  TokenInfo,
} from "./types";

// Re-export the shared session helper + the execution-leg helpers so dApp
// modules have a single import surface.
export { sessionId } from "../api";
export { reportDone, assemblePermitTx, simulate } from "../api";

// Generic JSON GET against /api/<path>?id=<sid>(&extra). Throws on non-2xx with
// the server's error string when present, so callers never swallow failures.
async function apiGet<T>(
  path: string,
  id: string,
  params: Record<string, string> = {},
): Promise<T> {
  const qs = new URLSearchParams({ id, ...params });
  const res = await fetch(`/api/${path}?${qs.toString()}`);
  if (!res.ok) {
    const detail = await readError(res);
    throw new Error(`/api/${path} failed: ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

// Generic JSON POST against /api/<path>?id=<sid> with a JSON body.
async function apiPost<T>(path: string, id: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${path}?${new URLSearchParams({ id }).toString()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await readError(res);
    throw new Error(`/api/${path} failed: ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

// Best-effort extraction of a server-provided error message for the thrown
// Error. Never throws itself — degrades to an empty suffix.
async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const json = JSON.parse(text) as { error?: string };
      return json.error ? ` — ${json.error}` : ` — ${text}`;
    } catch {
      return ` — ${text}`;
    }
  } catch {
    return "";
  }
}

// GET /api/mode → the interactive-mode bootstrap (chains, venues, defaults).
export async function getMode(id: string): Promise<ApiMode> {
  return apiGet<ApiMode>("mode", id);
}

// GET /api/tokens?chain=<alias> → curated per-chain token list.
export async function getTokens(id: string, chain: string): Promise<TokenInfo[]> {
  return apiGet<TokenInfo[]>("tokens", id, { chain });
}

// POST /api/resolve-token { chain, input } → resolved token (404 if unknown).
export async function resolveToken(
  id: string,
  chain: string,
  input: string,
): Promise<TokenInfo> {
  return apiPost<TokenInfo>("resolve-token", id, { chain, input });
}

// POST /api/quote → ranked routes (best-first). Needs no wallet.
export async function postQuote(
  id: string,
  req: QuoteRequest,
): Promise<QuoteResponse> {
  return apiPost<QuoteResponse>("quote", id, req);
}

// POST /api/quote/stream → NDJSON stream; invokes onEvent for each line as the
// venues settle, so the UI can render routes live. Resolves when the stream
// ends; pass an AbortSignal to cancel an in-flight quote (e.g. on new input).
export async function streamQuote(
  id: string,
  req: QuoteRequest,
  onEvent: (ev: QuoteStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/quote/stream?${new URLSearchParams({ id })}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await readError(res);
    throw new Error(`/api/quote/stream failed: ${res.status}${detail}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const flush = (line: string) => {
    const s = line.trim();
    if (!s) return;
    let ev: QuoteStreamEvent;
    try {
      ev = JSON.parse(s) as QuoteStreamEvent;
    } catch {
      return; // skip a malformed line rather than abort the whole stream
    }
    onEvent(ev);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      flush(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  flush(buf); // trailing line, if any
}

// POST /api/build → a Payload, feedable straight into the execution components.
export async function postBuild(
  id: string,
  req: BuildRequest,
): Promise<BuildPayload> {
  return apiPost<BuildPayload>("build", id, req);
}

// POST /api/route → symbol-labelled hops for the selected venue's route graph.
// Stateless: the full token/chain/amount context is carried in the request body
// rather than referencing a server-side cached quote by id.
export async function postRoute(
  id: string,
  req: RouteRequest,
): Promise<RouteGraphResponse> {
  return apiPost<RouteGraphResponse>("route", id, req);
}

// Convenience: read the sid once at module-import sites that prefer a thrown
// error to a missing param. Mirrors the legacy sessionId() contract.
export function currentSessionId(): string {
  return sessionId();
}

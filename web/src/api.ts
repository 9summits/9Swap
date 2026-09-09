// Tiny helpers for talking to the local CLI server.

export function sessionId(): string {
  // Empty when the URL carries no ?id= — accepted by a SWAP_NO_AUTH server,
  // 403 otherwise (App.tsx surfaces the missing-token error in that case).
  return new URLSearchParams(window.location.search).get("id") ?? "";
}

export async function fetchPayload(id: string) {
  const res = await fetch(`/tx?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`/tx failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// Body of POST /done. Mirrors src/server/done_report.ts on the CLI side.
// Keep both in sync.
export type DoneReport =
  | { kind: "tx"; hash: string; venue: string; chainId: number }
  | { kind: "order"; orderId: string; venue: string; chainId: number }
  | { kind: "error"; error: string; venue: string; chainId: number };

// Notify the CLI we're done — success carries a tx hash or order id,
// failure carries a string error. Every report also carries the venue and
// chainId so the server can count outcomes. The CLI then prints and exits.
export async function reportDone(id: string, body: DoneReport) {
  await fetch(`/done?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type AssembledTx = {
  to: string;
  from: string;
  data: string;
  value: string;
  gas: string | null;
  gasPrice: string | null;
  maxPriorityFeePerGas: string | null;
  spender: string;
  chainId: number;
};

import type { SimulateOutcome } from "./payload";

// Run eth_simulateV1 server-side (the CLI has the RPC, we don't).
// Returns the same SimulateOutcome shape the CLI's --simulate prints.
export async function simulate(id: string): Promise<SimulateOutcome> {
  const res = await fetch(`/simulate?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return (await res.json()) as SimulateOutcome;
}

// Path A second leg: hand the user's permit signature to the local
// server (or Vercel serverless), which posts to the venue's /v1/swap
// (with the API key) and returns the broadcastable tx. The optional
// `context` blob is passed through opaquely — stateless deployments use
// it to reconstruct the assemble call without an in-memory session.
export async function assemblePermitTx(
  id: string,
  signature: string,
  context?: unknown,
): Promise<AssembledTx> {
  const res = await fetch(`/assemble?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signature, ...(context !== undefined ? { context } : {}) }),
  });
  const json = (await res.json()) as { tx?: AssembledTx; error?: string };
  if (!res.ok || !json.tx) {
    throw new Error(json.error ?? `/assemble failed: ${res.status}`);
  }
  return json.tx;
}

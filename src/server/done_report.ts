// Wire contract for POST /done, shared by the local servers (src/browser.ts,
// src/serve.ts through src/server/handlers.ts) and the serverless function
// (api/done.ts). `web/src/api.ts` mirrors the DoneReport type on the client.

export type DoneReport =
  | { kind: "tx"; hash: string; venue: string; chainId: number }
  | { kind: "order"; orderId: string; venue: string; chainId: number }
  | { kind: "error"; error: string; venue: string; chainId: number };

export type DoneParse =
  | { ok: true; report: DoneReport }
  | { ok: false; reason: string };

export const DONE_ERROR_MAX = 100;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

// Wallet error strings routinely quote the sender address. The lookahead keeps
// the match off longer hex runs: unanchored, it eats the first 40 chars of a
// 32-byte tx hash and leaves 24 raw hex chars trailing the ellipsis.
function redactAddresses(s: string): string {
  return s.replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "0x…");
}

export function parseDoneReport(raw: unknown): DoneParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "body is not an object" };
  }
  const { kind, venue, chainId, hash, orderId, error } = raw as Record<string, unknown>;
  if (!isNonEmptyString(venue)) {
    return { ok: false, reason: "venue must be a non-empty string" };
  }
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) {
    return { ok: false, reason: "chainId must be a positive integer" };
  }
  switch (kind) {
    case "tx":
      if (!isNonEmptyString(hash)) {
        return { ok: false, reason: "tx report requires a hash string" };
      }
      return { ok: true, report: { kind: "tx", hash, venue, chainId } };
    case "order":
      if (!isNonEmptyString(orderId)) {
        return { ok: false, reason: "order report requires an orderId string" };
      }
      return { ok: true, report: { kind: "order", orderId, venue, chainId } };
    case "error":
      if (!isNonEmptyString(error)) {
        return { ok: false, reason: "error report requires an error string" };
      }
      return { ok: true, report: { kind: "error", error, venue, chainId } };
    default:
      return { ok: false, reason: `unknown kind: ${String(kind)}` };
  }
}

export function doneEventLine(report: DoneReport): string {
  const base = {
    evt: "done",
    kind: report.kind,
    venue: cap(report.venue, 64),
    chainId: report.chainId,
  };
  switch (report.kind) {
    case "tx":
      return JSON.stringify({ ...base, hash: cap(report.hash, 128) });
    case "order":
      return JSON.stringify({ ...base, orderId: cap(report.orderId, 128) });
    case "error":
      return JSON.stringify({ ...base, error: cap(redactAddresses(report.error), DONE_ERROR_MAX) });
  }
}

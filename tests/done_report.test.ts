// Unit tests for the /done wire contract (src/server/done_report.ts).
// Pure functions, no network — parsing guards plus the structured event line.
import { test, expect } from "bun:test";
import { parseDoneReport, doneEventLine, DONE_ERROR_MAX } from "../src/server/done_report.ts";

test("tx report parses and renders the event line with pinned key order", () => {
  const parsed = parseDoneReport({ kind: "tx", hash: "0xabc", venue: "kyber", chainId: 1 });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(parsed.report).toEqual({ kind: "tx", hash: "0xabc", venue: "kyber", chainId: 1 });
  expect(doneEventLine(parsed.report)).toBe(
    '{"evt":"done","kind":"tx","venue":"kyber","chainId":1,"hash":"0xabc"}',
  );
});

test("order report parses and renders the event line with pinned key order", () => {
  const parsed = parseDoneReport({ kind: "order", orderId: "0xdef", venue: "cow", chainId: 8453 });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(doneEventLine(parsed.report)).toBe(
    '{"evt":"done","kind":"order","venue":"cow","chainId":8453,"orderId":"0xdef"}',
  );
});

test("error report parses and renders the event line with pinned key order", () => {
  const parsed = parseDoneReport({ kind: "error", error: "user rejected", venue: "0x", chainId: 42161 });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  expect(doneEventLine(parsed.report)).toBe(
    '{"evt":"done","kind":"error","venue":"0x","chainId":42161,"error":"user rejected"}',
  );
});

test("null is not an object", () => {
  expect(parseDoneReport(null)).toEqual({ ok: false, reason: "body is not an object" });
});

test("an array is not an object", () => {
  expect(parseDoneReport([])).toEqual({ ok: false, reason: "body is not an object" });
});

test("a string is not an object", () => {
  expect(parseDoneReport("kind=tx")).toEqual({ ok: false, reason: "body is not an object" });
});

test("a body missing both venue and kind reports the venue reason", () => {
  expect(parseDoneReport({ hash: "0xabc", chainId: 1 })).toEqual({
    ok: false,
    reason: "venue must be a non-empty string",
  });
});

test("an empty-string venue is rejected", () => {
  expect(parseDoneReport({ kind: "tx", hash: "0xabc", venue: "", chainId: 1 })).toEqual({
    ok: false,
    reason: "venue must be a non-empty string",
  });
});

test("a missing chainId is rejected", () => {
  expect(parseDoneReport({ kind: "tx", hash: "0xabc", venue: "kyber" })).toEqual({
    ok: false,
    reason: "chainId must be a positive integer",
  });
});

test("a string chainId is rejected", () => {
  expect(parseDoneReport({ kind: "tx", hash: "0xabc", venue: "kyber", chainId: "1" })).toEqual({
    ok: false,
    reason: "chainId must be a positive integer",
  });
});

test("a fractional chainId is rejected", () => {
  expect(parseDoneReport({ kind: "tx", hash: "0xabc", venue: "kyber", chainId: 1.5 })).toEqual({
    ok: false,
    reason: "chainId must be a positive integer",
  });
});

test("an unknown kind names the offending value", () => {
  expect(parseDoneReport({ kind: "receipt", venue: "kyber", chainId: 1 })).toEqual({
    ok: false,
    reason: "unknown kind: receipt",
  });
});

test("a tx report without a hash is rejected", () => {
  expect(parseDoneReport({ kind: "tx", venue: "kyber", chainId: 1 })).toEqual({
    ok: false,
    reason: "tx report requires a hash string",
  });
});

test("parse keeps the full error text, the event line caps it", () => {
  const long = "x".repeat(150);
  const parsed = parseDoneReport({ kind: "error", error: long, venue: "kyber", chainId: 1 });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (parsed.report.kind !== "error") throw new Error("expected an error report");
  expect(parsed.report.error).toBe(long);
  const line = JSON.parse(doneEventLine(parsed.report)) as { error: string };
  expect(line.error.length).toBe(DONE_ERROR_MAX);
  expect(line.error).toBe("x".repeat(100));
});

test("a venue longer than 64 chars is capped in the event line", () => {
  const parsed = parseDoneReport({ kind: "tx", hash: "0xabc", venue: "v".repeat(80), chainId: 1 });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  const line = JSON.parse(doneEventLine(parsed.report)) as { venue: string };
  expect(line.venue).toBe("v".repeat(64));
});

test("an error containing a newline still yields a single-line event", () => {
  const parsed = parseDoneReport({
    kind: "error",
    error: "revert\nreason: insufficient balance",
    venue: "kyber",
    chainId: 1,
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.reason);
  const line = doneEventLine(parsed.report);
  expect(line.includes("\n")).toBe(false);
  expect(JSON.parse(line)).toMatchObject({ error: "revert\nreason: insufficient balance" });
});

test("wallet addresses inside the error text are redacted in the event line", () => {
  const parsed = parseDoneReport({
    kind: "error",
    error: "User rejected the request from 0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
    venue: "kyber",
    chainId: 1,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  const line = JSON.parse(doneEventLine(parsed.report)) as { error: string };
  expect(line.error).toBe("User rejected the request from 0x…");
});

test("a 32-byte tx hash inside the error text survives redaction intact", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const parsed = parseDoneReport({
    kind: "error",
    error: `tx failed: ${hash} reverted`,
    venue: "kyber",
    chainId: 1,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  const line = JSON.parse(doneEventLine(parsed.report)) as { error: string };
  expect(line.error).toBe(`tx failed: ${hash} reverted`);
});

test("an address is redacted while a tx hash in the same string is preserved", () => {
  const hash = `0x${"cd".repeat(32)}`;
  const parsed = parseDoneReport({
    kind: "error",
    error: `${hash} from 0xAbCdEf0123456789AbCdEf0123456789AbCdEf01`,
    venue: "kyber",
    chainId: 1,
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  const line = JSON.parse(doneEventLine(parsed.report)) as { error: string };
  expect(line.error).toBe(`${hash} from 0x…`);
});

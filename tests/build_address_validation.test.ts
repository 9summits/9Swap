import { describe, expect, test } from "bun:test";
import { toChecksumAddress } from "../src/checksum.ts";
import { handleAssemble, handleBuild } from "../src/server/handlers.ts";

const VALID_SENDER = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3";
const SHORT_39 = `0x${"1".repeat(39)}`;

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("toChecksumAddress", () => {
  test("throws on malformed input", () => {
    expect(() => toChecksumAddress(SHORT_39)).toThrow(/invalid address/);
    expect(() => toChecksumAddress("not-an-address")).toThrow(/invalid address/);
    expect(() => toChecksumAddress("")).toThrow(/invalid address/);
    expect(() => toChecksumAddress(`0x${"1".repeat(41)}`)).toThrow(/invalid address/);
  });

  test("checksums a valid 20-byte address", () => {
    expect(toChecksumAddress(VALID_SENDER.toLowerCase())).toBe(VALID_SENDER);
  });
});

describe("handleBuild address validation (HTTP 400)", () => {
  test("recipient 39-hex rejected", async () => {
    const res = await handleBuild(
      post("http://local/api/build", {
        venue: "send",
        sender: VALID_SENDER,
        recipient: SHORT_39,
        chain: "eth",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `invalid recipient address: ${SHORT_39}`,
    });
  });

  test("malformed sender rejected", async () => {
    const res = await handleBuild(
      post("http://local/api/build", {
        venue: "send",
        sender: SHORT_39,
        chain: "eth",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `invalid sender address: ${SHORT_39}`,
    });
  });
});

describe("handleAssemble address validation (HTTP 400)", () => {
  test("malformed ctx.sender rejected", async () => {
    const res = await handleAssemble(
      post("http://local/assemble", {
        signature: "0xab",
        context: {
          venue: "kyber",
          chain: "eth",
          sender: SHORT_39,
          quote: {},
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `invalid sender address: ${SHORT_39}`,
    });
  });
});

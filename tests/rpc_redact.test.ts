import { describe, expect, test } from "bun:test";
import { getGasPrice, getPriorityFee, redactRpc } from "../src/rpc.ts";

const ALCHEMY =
  "https://eth-mainnet.g.alchemy.com/v2/SECRET_ALCHEMY_KEY_LEAK_TEST";
const SECRET = "SECRET_ALCHEMY_KEY_LEAK_TEST";

async function captureErrorLogs(
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const orig = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
    return logs;
  } finally {
    console.error = orig;
  }
}

describe("redactRpc", () => {
  test("Alchemy path key is dropped; host remains", () => {
    expect(redactRpc(ALCHEMY)).toBe("eth-mainnet.g.alchemy.com");
  });

  test("userinfo is stripped", () => {
    expect(redactRpc("https://user:pass@rpc.example/path")).toBe("rpc.example");
  });

  test("unparseable input does not echo the input", () => {
    const raw = `not-a-url/${SECRET}`;
    const out = redactRpc(raw);
    expect(out).not.toContain(SECRET);
    expect(out).not.toBe(raw);
    expect(out).toBe("unparseable-rpc");
  });
});

describe("getPriorityFee / getGasPrice stderr", () => {
  test("getPriorityFee warning omits the key and names the host", async () => {
    const logs = await captureErrorLogs(() => getPriorityFee(ALCHEMY));
    const joined = logs.join("\n");
    expect(joined).not.toContain(SECRET);
    expect(joined).toContain("eth-mainnet.g.alchemy.com");
    expect(joined).toContain("priorityFee unavailable");
  });

  test("getGasPrice warning omits the key and names the host", async () => {
    const logs = await captureErrorLogs(() => getGasPrice(ALCHEMY));
    const joined = logs.join("\n");
    expect(joined).not.toContain(SECRET);
    expect(joined).toContain("eth-mainnet.g.alchemy.com");
    expect(joined).toContain("gasPrice unavailable");
  });
});

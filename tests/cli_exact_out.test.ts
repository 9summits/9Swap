import { describe, expect, test } from "bun:test";

// CLI unit tests for exact-out — spawn `bun run src/index.ts` and assert
// the FAST, LOCAL failure paths only. Every case here fails BEFORE any network
// I/O:
//   · the mutually-exclusive flag guards fire before token resolution;
//   · the exact-out / venue guards fire after resolution, but ETH↔ETH resolves
//     the native symbol to the 0xEee… sentinel with NO network call, so they
//     stay offline too;
//   · an invalid amount throws at toBaseUnits, before any venue is queried.
//
// Anything that would resolve an ERC20 SYMBOL (KyberSwap ks-setting / CoinGecko)
// or actually quote a venue hits the network and is deliberately OUT OF SCOPE —
// those paths are covered by the live smokes + the Playwright e2e, not here.

const ROOT = `${import.meta.dir}/..`;
// A valid checksummed 20-byte address for the send-recipient guard (never used
// on-chain — the command errors before any build).
const RECIPIENT = "0x1111111111111111111111111111111111111111";

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    // Short per-spawn ceiling: every case should exit in well under a second.
    signal: AbortSignal.timeout(20_000),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr, all: stdout + stderr };
}

describe("CLI exact-out guards (offline)", () => {
  test("--exact-out with -a send is rejected (swap-only)", async () => {
    const r = await runCli([
      "1", "ETH", "ETH", "--exact-out", "-a", "send", "--to", RECIPIENT,
    ]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/--exact-out is only supported for -a swap/);
    expect(r.all).toContain("-a send");
  });

  test("-v kyber --exact-out → UnsupportedSideError in text mode (exit 1)", async () => {
    const r = await runCli(["1", "ETH", "ETH", "--exact-out", "-v", "kyber"]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/kyber does not support exact-out \(sell-only\)/);
    // Names the buy-capable venues the user can switch to.
    expect(r.all).toMatch(/velora, matcha, uniswap, cow, ophis/);
  });

  test("-v kyber --exact-out --json → {error} shape (exit 1)", async () => {
    const r = await runCli(["1", "ETH", "ETH", "--exact-out", "-v", "kyber", "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.error).toMatch(/does not support exact-out/);
    // Nothing but the machine-readable object on stdout.
    expect(Object.keys(parsed)).toEqual(["error"]);
  });

  test("--json + --simple are mutually exclusive (exit 1, {error})", async () => {
    const r = await runCli(["1", "ETH", "USDT", "--json", "--simple"]);
    expect(r.code).toBe(1);
    // The guard fires before token resolution, so USDT never hits the network.
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.error).toBe("--json and --simple are mutually exclusive");
  });

  test("--simple + --data are mutually exclusive (exit 1, text)", async () => {
    const r = await runCli(["1", "ETH", "USDT", "--simple", "--data"]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/--simple and --data are mutually exclusive/);
  });

  test("invalid amount is rejected before any quote (exit 1)", async () => {
    const r = await runCli(["abc", "ETH", "ETH", "-v", "kyber"]);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/invalid amount/i);
  });
});

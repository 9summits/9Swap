import { describe, expect, test } from "bun:test";

const ROOT = `${import.meta.dir}/..`;

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; all: string }> {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    signal: AbortSignal.timeout(20_000),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr, all: stdout + stderr };
}

const HIDDEN_FROM_DEFAULT_HELP = [
  "unstakesavax",
  "claimsavax",
  "unwrapwrseth",
  "withdrawsparkweth",
  "showcustomhelp",
  "Kelp",
  "BENQI",
  "Spark",
] as const;

describe("CLI --help action list", () => {
  test("default --help only lists everyday -a actions", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/-a, --action/);
    expect(r.all).toContain("`swap`");
    expect(r.all).toContain("`send`");
    expect(r.all).toContain("`addwallet`");
    expect(r.all).toContain("swap update");
    expect(r.all).toContain("swap --init");
    for (const needle of HIDDEN_FROM_DEFAULT_HELP) {
      expect(r.all).not.toContain(needle);
    }
  });

  test("--showcustomhelp --help documents special actions", async () => {
    const r = await runCli(["--showcustomhelp", "--help"]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("unstakesavax");
    expect(r.all).toContain("unwrapwrseth");
    expect(r.all).toContain("claimsavax");
    expect(r.all).toContain("withdrawsparkweth");
    // Hidden flag must not appear in the Options list.
    expect(r.all).not.toContain("--showcustomhelp");
  });

  test("--help --showcustomhelp also documents special actions", async () => {
    const r = await runCli(["--help", "--showcustomhelp"]);
    expect(r.code).toBe(0);
    expect(r.all).toContain("unstakesavax");
    expect(r.all).toContain("unwrapwrseth");
    expect(r.all).not.toContain("--showcustomhelp");
  });
});

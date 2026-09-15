import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { CLI_VERSION, formatVersion, resolveBuildInfo } from "../src/version.ts";

const PROJECT_ROOT = resolve(dirname(import.meta.dir));

test("formatVersion renders sha + date, sha alone, and the unknown-build fallback", () => {
  expect(
    formatVersion({ version: "0.1.0", sha: "2c02339", date: "2026-09-15" }),
  ).toBe("swap 0.1.0 (2c02339, 2026-09-15)");
  expect(formatVersion({ version: "0.1.0", sha: "2c02339", date: null })).toBe(
    "swap 0.1.0 (2c02339)",
  );
  expect(formatVersion({ version: "0.1.0", sha: null, date: null })).toBe(
    "swap 0.1.0 (unknown build)",
  );
  // A date without a sha is not enough to identify a build.
  expect(
    formatVersion({ version: "0.1.0", sha: null, date: "2026-09-15" }),
  ).toBe("swap 0.1.0 (unknown build)");
});

test("CLI_VERSION comes from package.json and resolveBuildInfo never throws", () => {
  expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  const info = resolveBuildInfo();
  expect(info).toHaveProperty("sha");
  expect(info).toHaveProperty("date");
  if (info.sha !== null) expect(info.sha).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
});

test("scripts/build-info.ts emits a BUILD_INFO module with this repo's sha", () => {
  const proc = Bun.spawnSync(["bun", "scripts/build-info.ts"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain(
    "export const BUILD_INFO: { sha: string | null; date: string | null }",
  );
  expect(out).toMatch(/"date": "\d{4}-\d{2}-\d{2}"/);

  // Only assert on the sha when git can actually answer here (a tarball
  // checkout legitimately yields null, and the build must still work).
  const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (head.exitCode === 0) {
    const sha = head.stdout.toString().trim();
    expect(out).toContain(`"sha": "${sha}`);
    expect(out).toMatch(/"sha": "[0-9a-f]{7,}(-dirty)?"/);
  }
});

// `swap --version` — the package version plus the commit the binary was built
// from, so a bug report on a prebuilt binary names an exact source revision.
//
// Two sources, in order:
//   1. BUILD_INFO (src/build_info.ts) — stamped by ./build and ./build-all
//      right before `bun build --compile`, then restored to its null stub.
//      This is what a released binary carries.
//   2. A dev run (`bun run src/index.ts`) has the null stub, so we ask git
//      directly, from the project directory. Any failure (no git, a tarball
//      checkout, a compiled binary built without git) degrades to null — this
//      never throws and never blocks the command.
import { dirname, resolve } from "node:path";
import pkg from "../package.json";
import { BUILD_INFO } from "./build_info.ts";

/** Version string from package.json — the single source of truth for both
 *  `--version` and the hosted-mode User-Agent (see src/remote.ts). */
export const CLI_VERSION = (pkg as { version?: string }).version ?? "0.0.0";

export type BuildInfo = { sha: string | null; date: string | null };

let cached: BuildInfo | null = null;

/** Embedded build info, or the git fallback in dev. Memoised: at most one
 *  `git rev-parse` per process, whoever asks first. */
export function resolveBuildInfo(): BuildInfo {
  if (cached) return cached;
  cached = BUILD_INFO.sha
    ? { sha: BUILD_INFO.sha, date: BUILD_INFO.date }
    : { sha: gitShortSha(), date: BUILD_INFO.date };
  return cached;
}

/** `git rev-parse --short HEAD` in the project directory, or null. Never throws. */
function gitShortSha(): string | null {
  if (typeof Bun === "undefined") return null;
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: resolve(dirname(import.meta.dir)),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const sha = proc.stdout.toString().trim();
    return sha || null;
  } catch {
    // git missing, or a compiled binary whose import.meta.dir is virtual.
    return null;
  }
}

/**
 * `swap 0.1.0 (2c02339, 2026-09-15)`, or `swap 0.1.0 (2c02339)` without a
 * date, or `swap 0.1.0 (unknown build)` when the sha could not be resolved.
 */
export function formatVersion(info: {
  version: string;
  sha: string | null;
  date: string | null;
}): string {
  const base = `swap ${info.version}`;
  if (!info.sha) return `${base} (unknown build)`;
  return info.date
    ? `${base} (${info.sha}, ${info.date})`
    : `${base} (${info.sha})`;
}

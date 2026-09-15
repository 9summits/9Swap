// Prints a TypeScript module on stdout that exports BUILD_INFO: the commit
// sha the build came from, plus the UTC build date. Used by ./build and
// ./build-all to bake provenance into src/build_info.ts immediately before
// compile (and restore the stub afterwards), exactly like scripts/embed-env.ts
// does for .env → src/env.embedded.ts.
//
// Usage:
//   bun scripts/build-info.ts > src/build_info.ts
//
// The sha is `git rev-parse --short HEAD`, suffixed `-dirty` when the working
// tree carries changes other than the two files the build itself rewrites
// (src/build_info.ts, src/env.embedded.ts) — otherwise every build would call
// itself dirty. When git is unavailable (tarball checkout, no git binary) the
// sha stays null and the build still succeeds; `swap --version` then prints
// "unknown build".
//
// Stderr carries a one-line summary so the build output stays informative
// without polluting the file we redirect stdout into.
import { dirname, resolve } from "node:path";

const PROJECT_ROOT = resolve(dirname(import.meta.dir));

// Files the build script itself rewrites before compiling — their modified
// state says nothing about the source the binary was built from.
const BUILD_REWRITTEN = new Set(["src/build_info.ts", "src/env.embedded.ts"]);

function git(args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    // No git binary at all — not an error, just no provenance.
    return null;
  }
}

/** True when `git status --porcelain` lists anything the build didn't rewrite. */
function isDirty(): boolean {
  const status = git(["status", "--porcelain"]);
  if (status === null) return false;
  for (const raw of status.split("\n")) {
    if (!raw.trim()) continue;
    // Porcelain v1: "XY <path>", with "XY <old> -> <new>" for renames.
    let path = raw.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!BUILD_REWRITTEN.has(path)) return true;
  }
  return false;
}

const short = git(["rev-parse", "--short", "HEAD"]);
const sha = short ? (isDirty() ? `${short}-dirty` : short) : null;
const date = new Date().toISOString().slice(0, 10);

process.stdout.write(
  "// Auto-generated at build time by ./build — do not edit.\n" +
    "// Restored to the committed stub immediately after compile.\n" +
    "export const BUILD_INFO: { sha: string | null; date: string | null } = " +
    JSON.stringify({ sha, date }, null, 2) +
    ";\n",
);
process.stderr.write(
  sha
    ? `  build info: ${sha} (${date})\n`
    : `  build info: no git — sha stays null (${date})\n`,
);

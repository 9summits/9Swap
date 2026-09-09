// Reads a .env-style file and prints a TypeScript module on stdout that
// exports EMBEDDED_ENV with those values. Used by ./build to bake env into
// src/env.embedded.ts immediately before compile.
//
// Usage:
//   bun scripts/embed-env.ts [.env]
//   bun scripts/embed-env.ts .env.install
//   bun scripts/embed-env.ts .env.install --include-rpc   # rare: also bake Alchemy
//
// By default, RPC-related keys (ALCHEMY_API_KEY, RPC_URL_<chainId>,
// <ALIAS>_RPC_URL) are excluded — personal quota / private nodes.
// Public curl-install builds embed a curated `.env.install` (venue keys,
// referrals, …) without RPC. Recipients configure Alchemy / RPC via the
// first-run prompt or `swap --init` (~/.swap).
//
// Stderr carries a one-line summary so the build output stays informative
// without polluting the file we redirect stdout into.
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--");
const includeRpc = args.includes("--include-rpc");
const path = args.find((a) => !a.startsWith("--")) ?? ".env";
const out: Record<string, string> = {};
const skipped: string[] = [];

function isRpcKey(key: string): boolean {
  if (key === "ALCHEMY_API_KEY") return true;
  if (key.startsWith("RPC_URL_")) return true;
  if (key.endsWith("_RPC_URL")) return true;
  return false;
}

if (existsSync(path)) {
  const content = readFileSync(path, "utf8");
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue;
    if (!includeRpc && isRpcKey(key)) {
      skipped.push(key);
      continue;
    }
    out[key] = value;
  }
}

const keys = Object.keys(out);
process.stdout.write(
  "// Auto-generated at build time by ./build — do not edit.\n" +
    "// Restored to an empty stub immediately after compile.\n" +
    "export const EMBEDDED_ENV: Record<string, string> = " +
    JSON.stringify(out, null, 2) +
    ";\n",
);
process.stderr.write(
  `  embedded ${keys.length} key(s) from ${path}${keys.length ? ": " + keys.join(", ") : ""}\n`,
);
if (skipped.length > 0) {
  process.stderr.write(
    `  excluded ${skipped.length} RPC key(s) (pass --include-rpc to keep): ${skipped.join(", ")}\n`,
  );
}
if (keys.length > 0) {
  process.stderr.write(
    `  ⚠ the binary now contains these values — treat the artifact as sensitive.\n`,
  );
}

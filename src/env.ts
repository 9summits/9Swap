import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBEDDED_ENV } from "./env.embedded.ts";
import {
  ensureSwapDir,
  homeSwapConfigPath,
  migrateLegacySwapFile,
} from "./swapdir.ts";

// Populate `process.env` from four sources, in priority order:
//   1. The shell environment (already in process.env on entry — left
//      untouched).
//   2. A `.env` file in the current working directory.
//   3. `$HOME/.swap/config` — written by the first-run interactive prompt
//      (see `maybePromptForRpcConfig`). Holds Alchemy key / RPC URLs
//      that the user wants to persist across all swap invocations
//      regardless of cwd. The legacy `$HOME/.swap` flat file is
//      auto-migrated to `$HOME/.swap/config` on first run.
//   4. EMBEDDED_ENV — values baked into the binary at build time by the
//      ./build script when a `.env` exists in the project root. This is
//      what makes the compiled binary usable from any directory: your
//      keys travel with the binary as a fallback.
//
// Each later source only fills keys that aren't already set.
export function loadDotenv(cwd = process.cwd()): void {
  migrateLegacySwapFile();

  const cwdEnv = resolve(cwd, ".env");
  if (existsSync(cwdEnv)) loadKeyValueFile(cwdEnv);

  const homeSwap = homeSwapConfigPath();
  if (homeSwap && existsSync(homeSwap)) loadKeyValueFile(homeSwap);

  for (const [key, value] of Object.entries(EMBEDDED_ENV)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadKeyValueFile(path: string): void {
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
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Returns true if any RPC source is already configured. Mirrors what
// getRpcUrl checks (Alchemy key, per-chainId override, per-alias
// override). We don't import chains.ts here to avoid a cycle, so we
// scan env vars by prefix.
export function hasAnyRpcConfig(): boolean {
  if (process.env.ALCHEMY_API_KEY) return true;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("RPC_URL_")) return true;
    if (key.endsWith("_RPC_URL")) return true;
  }
  return false;
}

// Read a single line from stdin without echoing the prompt or buffering
// in line-mode. Bun's stdin is a Node-compatible Readable; we use the
// async iterator and stop after the first line. Resolves to the trimmed
// input, or "" if the user pressed Enter immediately.
async function readLine(): Promise<string> {
  // dynamic import keeps `readline` out of the binary's startup path
  // for invocations that never prompt.
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const line = await rl.question("");
    return line.trim();
  } finally {
    rl.close();
  }
}

// First-run interactive prompt: when no RPC is configured AND we're on
// a TTY, ask the user to paste an Alchemy API key or a full RPC URL.
// Saves the answer to ~/.swap (chmod 600). Pressing Enter writes a
// "skipped" marker file so we don't re-prompt next run; features that
// need RPC will degrade gracefully.
//
// Skip conditions (all bypassed when `force: true`):
//   - non-TTY (piped, scripted, CI) — never bypassed; can't prompt
//     without one
//   - --json / --simple modes (machine consumers)
//   - ~/.swap already exists (any content, including the skip marker)
//   - RPC already configured (env / cwd .env / embedded)
//
// `force` is set by the explicit `--init` command path: the user
// asked for the prompt, so we re-run it even if config exists, and
// overwrite ~/.swap if present.
export async function maybePromptForRpcConfig(opts: {
  json?: boolean;
  simple?: boolean;
  force?: boolean;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    if (opts.force) {
      process.stderr.write(
        "swap --init requires an interactive terminal " +
          "(stdin/stderr must be a TTY).\n",
      );
      process.exit(1);
    }
    return;
  }
  if (!opts.force) {
    if (opts.json || opts.simple) return;
    if (hasAnyRpcConfig()) return;
  }

  const homeSwap = homeSwapConfigPath();
  if (!homeSwap) return;
  if (!opts.force && existsSync(homeSwap)) return;

  if (opts.force) {
    process.stderr.write(
      "\n  swap --init: configure or replace your RPC config.\n",
    );
    if (hasAnyRpcConfig()) {
      process.stderr.write(
        "  (an RPC is already configured via env / .env / embedded — " +
          "writing ~/.swap/config will only override the lower-priority sources)\n",
      );
    }
    if (existsSync(homeSwap)) {
      process.stderr.write(
        "  (existing ~/.swap/config will be overwritten)\n",
      );
    }
    process.stderr.write("\n");
  } else {
    process.stderr.write(
      "\n" +
        "  swap CLI: no RPC configured.\n" +
        "  Some features need an RPC endpoint:\n" +
        "    - allowance check + tx build (-d)\n" +
        "    - simulation (--simulate)\n" +
        "    - curve venue\n" +
        "    - decimals fallback for unknown tokens\n" +
        "  Quotes from kyber / odos / velora / matcha / 1inch / uniswap\n" +
        "  still work without RPC.\n\n",
    );
  }

  process.stderr.write(
    "  Paste your Alchemy API key, a full RPC URL" +
      (opts.force
        ? ", or press Enter to abort (won't change ~/.swap/config):\n  > "
        : ", or press Enter to\n  skip (won't ask again — delete ~/.swap/config to re-prompt):\n  > "),
  );

  let input: string;
  try {
    input = await readLine();
  } catch {
    return; // EOF / no input — silently skip
  }

  // Ensure ~/.swap exists as a dir before any write.
  ensureSwapDir();

  if (!input) {
    if (opts.force) {
      process.stderr.write("  aborted — ~/.swap/config unchanged.\n\n");
      return;
    }
    // Skip marker — keeps us from re-prompting every invocation.
    writeAndChmod(
      homeSwap,
      "# swap CLI — RPC prompt skipped. Delete this file to re-prompt.\n",
    );
    process.stderr.write(
      "  skipped — features needing RPC will be disabled.\n\n",
    );
    return;
  }

  let body: string;
  if (/^https?:\/\//i.test(input)) {
    // Full URL — defaults to mainnet (chainId 1). The user can edit
    // ~/.swap/config later for other chains (RPC_URL_<chainId> lines).
    body =
      `# swap CLI — RPC config (chmod 600). Add per-chain overrides as needed.\n` +
      `RPC_URL_1=${input}\n`;
    process.stderr.write(
      "  saved to ~/.swap/config as RPC_URL_1 (mainnet). " +
        "Add RPC_URL_<chainId> or <ALIAS>_RPC_URL lines for other chains.\n\n",
    );
  } else if (/^[A-Za-z0-9_-]{16,}$/.test(input)) {
    // Looks like an Alchemy API key — opaque token, alphanum + _-.
    body =
      `# swap CLI — RPC config (chmod 600).\n` +
      `ALCHEMY_API_KEY=${input}\n`;
    process.stderr.write(
      "  saved to ~/.swap/config as ALCHEMY_API_KEY (covers every supported chain).\n\n",
    );
  } else {
    process.stderr.write(
      "  unrecognised input (not http(s):// URL, not a plausible API key) — " +
        "not saved. Re-run to try again.\n\n",
    );
    return;
  }

  writeAndChmod(homeSwap, body);
  // Re-load so the just-saved values take effect for this invocation.
  loadKeyValueFile(homeSwap);
}


function writeAndChmod(path: string, content: string): void {
  try {
    writeFileSync(path, content, { encoding: "utf8" });
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(
      `  warning: could not write ${path} — ${(err as Error).message}\n`,
    );
  }
}

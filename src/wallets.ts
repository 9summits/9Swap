import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { toChecksumAddress } from "./checksum.ts";
import { ensureSwapDir, homeSwapWalletsPath } from "./swapdir.ts";

// Wallet alias registry at ~/.swap/wallets.json — a flat
// { aliasLower: checksumAddr } map. Aliases let users pass
// readable names to --from / --to instead of a full 0x address.

export type WalletEntry = { alias: string; address: string };

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
// Aliases must be non-empty, no whitespace, and not look like an address
// (otherwise resolution becomes ambiguous). Kept loose so users can pick
// what they want (e.g. "9seth", "main", "treasury-v2").
const ALIAS_RE = /^[A-Za-z0-9_\-.]{1,64}$/;

function readWallets(): Record<string, string> {
  const path = homeSwapWalletsPath();
  if (!path || !existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string" && ADDR_RE.test(v)) {
        out[k.toLowerCase()] = v;
      }
    }
    return out;
  } catch (err) {
    process.stderr.write(
      `  warning: ${path} unreadable — ${(err as Error).message}\n`,
    );
    return {};
  }
}

function writeWallets(wallets: Record<string, string>): void {
  const dir = ensureSwapDir();
  const path = homeSwapWalletsPath();
  if (!dir || !path) {
    throw new Error("cannot determine home directory; refusing to write wallets");
  }
  writeFileSync(path, `${JSON.stringify(wallets, null, 2)}\n`, "utf8");
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(
      `  warning: could not chmod 600 ${path} — ${(err as Error).message}\n`,
    );
  }
}

export function addWallet(alias: string, address: string): WalletEntry {
  const aliasLower = alias.toLowerCase();
  if (!ALIAS_RE.test(alias)) {
    throw new Error(
      `wallet alias must match ${ALIAS_RE.source} (got ${JSON.stringify(alias)})`,
    );
  }
  if (ADDR_RE.test(alias)) {
    throw new Error(`wallet alias must not look like an address`);
  }
  if (!ADDR_RE.test(address)) {
    throw new Error(`wallet address must be a 0x-prefixed 20-byte hex string`);
  }
  const checksum = toChecksumAddress(address);
  const wallets = readWallets();
  wallets[aliasLower] = checksum;
  writeWallets(wallets);
  return { alias: aliasLower, address: checksum };
}

export function listWallets(): WalletEntry[] {
  const wallets = readWallets();
  return Object.entries(wallets)
    .map(([alias, address]) => ({ alias, address }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

// Resolves a CLI input that may be either a 0x address or an alias.
// Returns the checksummed address. Throws if the alias is unknown.
// Inputs already in 0x form are returned as-is (after checksum
// normalisation) so this is safe to call unconditionally on
// --from / --to / SENDER_ADDRESS values.
export function resolveWalletInput(input: string): string {
  if (ADDR_RE.test(input)) return toChecksumAddress(input);
  const wallets = readWallets();
  const hit = wallets[input.toLowerCase()];
  if (!hit) {
    const known = Object.keys(wallets);
    const hint = known.length
      ? ` known aliases: ${known.join(", ")}`
      : ` no wallets registered yet — use \`swap --action addwallet <alias> <addr>\``;
    throw new Error(`unknown wallet alias ${JSON.stringify(input)}.${hint}`);
  }
  return hit;
}

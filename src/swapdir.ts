import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ~/.swap used to be a flat KEY=VALUE file. It is now a directory holding:
//   - config         the env file (Alchemy key / RPC URLs)
//   - wallets.json   addWallet alias → checksummed address registry
// `migrateLegacySwapFile` converts the old layout in place at startup so
// users upgrading don't lose their RPC config.

export function homeSwapDir(): string | null {
  const home = homedir();
  if (!home) return null;
  return resolve(home, ".swap");
}

export function homeSwapConfigPath(): string | null {
  const dir = homeSwapDir();
  return dir ? resolve(dir, "config") : null;
}

export function homeSwapWalletsPath(): string | null {
  const dir = homeSwapDir();
  return dir ? resolve(dir, "wallets.json") : null;
}

export function ensureSwapDir(): string | null {
  const dir = homeSwapDir();
  if (!dir) return null;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

// Idempotent. If ~/.swap exists and is a regular file, read its contents,
// create ~/.swap as a directory, and write the contents to ~/.swap/config.
// Returns true if a migration happened.
export function migrateLegacySwapFile(): boolean {
  const dir = homeSwapDir();
  if (!dir || !existsSync(dir)) return false;
  const st = statSync(dir);
  if (st.isDirectory()) return false;
  if (!st.isFile()) return false;

  const legacyContent = readFileSync(dir, "utf8");
  // Rename the file out of the way, create the dir, drop the content as
  // `config`. Using rename then unlink-via-overwrite would race; the two
  // step rename-then-mkdir-then-write avoids any window without backup.
  const backup = `${dir}.legacy`;
  renameSync(dir, backup);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfg = resolve(dir, "config");
  writeFileSync(cfg, legacyContent, { encoding: "utf8", mode: 0o600 });
  process.stderr.write(
    `  swap: migrated ${dir} (file) → ${dir}/config (legacy backup at ${backup})\n`,
  );
  return true;
}

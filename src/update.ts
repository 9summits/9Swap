import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// /cli/* 302s to the public Blob store. Override with SWAP_INSTALL_BASE.
export const DEFAULT_INSTALL_BASE = "https://swap.9summits.io/cli";

// Bun-compiled binaries are tens of MB; a few KB is almost always 404 HTML.
export const MIN_BINARY_BYTES = 1_000_000;

export const MAX_REDIRECTS = 5;

const INTERPRETER_NAMES = new Set(["bun", "bun.exe", "node", "node.exe"]);

export function detectAsset(platform: string, arch: string): string {
  const osRaw = platform.toLowerCase();
  let os: "darwin" | "linux";
  if (osRaw === "darwin" || osRaw === "linux") {
    os = osRaw;
  } else if (
    osRaw === "win32" ||
    osRaw.startsWith("msys") ||
    osRaw.startsWith("mingw") ||
    osRaw.startsWith("cygwin")
  ) {
    throw new Error(
      "Windows is not supported by this installer yet. Build from source.",
    );
  } else {
    throw new Error(
      `unsupported OS: ${platform}. Supported: macOS (darwin), Linux.`,
    );
  }

  let mapped = arch.toLowerCase();
  if (mapped === "x86_64" || mapped === "amd64") mapped = "x64";
  else if (mapped === "aarch64") mapped = "arm64";
  if (mapped !== "x64" && mapped !== "arm64") {
    throw new Error(
      `unsupported architecture: ${arch}. Supported: x64, arm64.`,
    );
  }

  return `swap-${os}-${mapped}`;
}

export function looksLikeInstalledSwapBinary(execPath: string): boolean {
  const base = basename(execPath).toLowerCase();
  if (INTERPRETER_NAMES.has(base)) return false;
  return base === "swap" || base === "swap.exe";
}

const MAX_CHECKSUM_BYTES = 8192;

export function installBase(
  env: NodeJS.Dict<string> = process.env,
): string {
  const raw = (env.SWAP_INSTALL_BASE ?? DEFAULT_INSTALL_BASE).trim();
  const base = raw.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) {
    throw new Error(
      `SWAP_INSTALL_BASE must be an https URL (got ${raw})`,
    );
  }
  return base;
}

// Same key=value line rules as loadKeyValueFile in env.ts.
function parseDotenvText(content: string): Record<string, string> {
  const out: Record<string, string> = {};
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
    if (key) out[key] = value;
  }
  return out;
}

export function parseSha256Manifest(text: string, url: string): string {
  const token = text.trim().split(/\s+/)[0] ?? "";
  const hex = token.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `checksum at ${url} is not a 64-char SHA-256 hex digest`,
    );
  }
  return hex;
}

function bunAutoEnvFiles(cwd: string, nodeEnv: string | undefined): string[] {
  const files = [join(cwd, ".env")];
  if (nodeEnv) files.push(join(cwd, `.env.${nodeEnv}`));
  if (nodeEnv !== "test") files.push(join(cwd, ".env.local"));
  if (nodeEnv) files.push(join(cwd, `.env.${nodeEnv}.local`));
  return files;
}

function cwdDotenvValues(
  cwd: string,
  nodeEnv: string | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of bunAutoEnvFiles(cwd, nodeEnv)) {
    if (!existsSync(file)) continue;
    Object.assign(merged, parseDotenvText(readFileSync(file, "utf8")));
  }
  return merged;
}

function ignoreCwdDotenvInstallOverrides(
  env: NodeJS.Dict<string>,
  cwd: string,
  stderr: (line: string) => void,
): void {
  // Bun auto-loads cwd .env into process.env before our code runs, including
  // compiled binaries. A matching value is file-injected, not a real shell export.
  const file = cwdDotenvValues(cwd, env.NODE_ENV);
  if (
    env.SWAP_INSTALL_BASE !== undefined &&
    file.SWAP_INSTALL_BASE !== undefined &&
    env.SWAP_INSTALL_BASE === file.SWAP_INSTALL_BASE
  ) {
    delete env.SWAP_INSTALL_BASE;
    stderr(
      "ignoring SWAP_INSTALL_BASE from a .env file in the current directory",
    );
  }
  if (
    env.SWAP_INSTALL_DIR !== undefined &&
    file.SWAP_INSTALL_DIR !== undefined &&
    env.SWAP_INSTALL_DIR === file.SWAP_INSTALL_DIR
  ) {
    delete env.SWAP_INSTALL_DIR;
    stderr(
      "ignoring SWAP_INSTALL_DIR from a .env file in the current directory",
    );
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchManual(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let current = url;
  for (let hopsLeft = MAX_REDIRECTS; hopsLeft >= 0; hopsLeft--) {
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: "manual" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to download ${current}: ${msg}`);
    }
    if (res.status >= 200 && res.status < 300) return res;
    if (!REDIRECT_STATUSES.has(res.status)) {
      throw new Error(
        `failed to download from ${current}: HTTP ${res.status}` +
          (res.statusText ? ` ${res.statusText}` : ""),
      );
    }
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(
        `redirect from ${current} has no location header (HTTP ${res.status})`,
      );
    }
    let target: URL;
    try {
      target = new URL(location, current);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `redirect from ${current} points at an unparseable location ${location}: ${msg}`,
      );
    }
    // The same redirect chain serves the binary and its .sha256, so one plaintext
    // hop would let a network attacker substitute both consistently.
    if (target.protocol !== "https:") {
      throw new Error(
        `refusing redirect to non-https URL ${target} while downloading ${url}`,
      );
    }
    current = target.toString();
  }
  throw new Error(
    `too many redirects (more than ${MAX_REDIRECTS}) while downloading ${url}`,
  );
}

async function downloadChecksum(
  url: string,
  opts: {
    fetch?: typeof fetch;
    maxBytes?: number;
  } = {},
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_CHECKSUM_BYTES;
  let res: Response;
  try {
    res = await fetchManual(url, fetchImpl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SHA-256 manifest missing or unreadable at ${url}: ${msg}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error(
      `checksum at ${url} is unreadable (${bytes.byteLength} bytes; expected a 64-char SHA-256 hex digest)`,
    );
  }
  return parseSha256Manifest(new TextDecoder().decode(bytes), url);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function sha256Digest(bytes: Uint8Array): Promise<Buffer> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes)),
  );
}

async function verifySha256(
  bytes: Uint8Array,
  expectedHex: string,
  url: string,
): Promise<void> {
  const digest = await sha256Digest(bytes);
  const expected = Buffer.from(expectedHex, "hex");
  if (
    digest.length !== expected.length ||
    !timingSafeEqual(digest, expected)
  ) {
    throw new Error(
      `checksum mismatch for ${url}: expected ${expectedHex}, got ${digest.toString("hex")}`,
    );
  }
}

export function assetUrl(
  asset: string,
  env: NodeJS.Dict<string> = process.env,
): string {
  return `${installBase(env)}/${asset}`;
}

export function resolveUpdateDest(opts: {
  execPath: string;
  env?: NodeJS.Dict<string>;
  homedir?: string;
  exists?: (path: string) => boolean;
}): string {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  if (looksLikeInstalledSwapBinary(opts.execPath)) {
    if (!exists(opts.execPath)) {
      throw new Error(
        `installed swap binary not found at ${opts.execPath}`,
      );
    }
    return rejectHomebrewDest(opts.execPath);
  }

  const home = opts.homedir ?? homedir();
  if (!home && !env.SWAP_INSTALL_DIR) {
    throw new Error(
      "cannot resolve install destination: home directory is empty and SWAP_INSTALL_DIR is unset",
    );
  }
  const dir = env.SWAP_INSTALL_DIR || join(home, ".local", "bin");
  const dest = join(dir, "swap");
  if (!exists(dest)) {
    throw new Error(
      `no installed swap binary found at ${dest}\n` +
        `  install with: curl -fsSL https://swap.9summits.io/install.sh | bash\n` +
        `  or set SWAP_INSTALL_DIR to the directory that contains the swap binary`,
    );
  }
  return rejectHomebrewDest(dest);
}

// Bun resolves symlinks in process.execPath, so a brew-linked binary shows up
// under its Cellar path. HOMEBREW_PREFIX is deliberately not consulted: on an
// Intel Mac it is /usr/local, where a curl-installed swap may legitimately live.
function rejectHomebrewDest(dest: string): string {
  if (dest.includes("/Cellar/")) {
    throw new Error(
      "refusing to overwrite a Homebrew Cellar path. Install with: curl -fsSL https://swap.9summits.io/install.sh | bash",
    );
  }
  return dest;
}

export function formatByteSize(n: number): string {
  if (n >= 1_048_576) {
    const x10 = Math.round((n * 10) / 1_048_576);
    return `${Math.floor(x10 / 10)}.${x10 % 10} MB`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export async function downloadAsset(
  url: string,
  opts: {
    fetch?: typeof fetch;
    minBytes?: number;
  } = {},
): Promise<{ bytes: Uint8Array; lastModified: string | null }> {
  const fetchImpl = opts.fetch ?? fetch;
  const minBytes = opts.minBytes ?? MIN_BINARY_BYTES;
  const res = await fetchManual(url, fetchImpl);
  const lastModified = res.headers.get("last-modified");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`downloaded file is empty — check ${url}`);
  }
  if (bytes.byteLength < minBytes) {
    throw new Error(
      `downloaded file is only ${bytes.byteLength} bytes (expected a multi-MB binary). URL may be wrong or the asset missing: ${url}`,
    );
  }
  return { bytes, lastModified };
}

export function atomicReplaceBinary(dest: string, bytes: Uint8Array): void {
  const tmp = join(
    dirname(dest),
    `.swap-update.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tmp, bytes);
    chmodSync(tmp, 0o755);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch (cleanupErr) {
      const code =
        cleanupErr &&
        typeof cleanupErr === "object" &&
        "code" in cleanupErr
          ? String((cleanupErr as { code: unknown }).code)
          : undefined;
      if (code !== "ENOENT") {
        const msg =
          cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr);
        process.stderr.write(
          `swap update: failed to remove temp file ${tmp}: ${msg}\n`,
        );
      }
    }
    throw err;
  }
}

export type RunUpdateOpts = {
  execPath?: string;
  env?: NodeJS.Dict<string>;
  cwd?: string;
  homedir?: string;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  minBytes?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

export async function runUpdate(
  opts: RunUpdateOpts = {},
): Promise<{
  dest: string;
  bytes: number;
  lastModified: string | null;
  updated: boolean;
}> {
  const env: NodeJS.Dict<string> = { ...(opts.env ?? process.env) };
  const writeErr = opts.stderr ?? ((line) => process.stderr.write(line + "\n"));
  const writeOut = opts.stdout ?? ((line) => process.stdout.write(line + "\n"));
  ignoreCwdDotenvInstallOverrides(
    env,
    opts.cwd ?? process.cwd(),
    writeErr,
  );
  const asset = detectAsset(
    opts.platform ?? process.platform,
    opts.arch ?? process.arch,
  );
  const dest = resolveUpdateDest({
    execPath: opts.execPath ?? process.execPath,
    env,
    homedir: opts.homedir,
    exists: opts.exists,
  });
  const url = assetUrl(asset, env);
  const checksumUrl = `${url}.sha256`;

  // The manifest is a few bytes; the binary is tens of MB. Fetch the digest
  // first so an already-current install skips the download entirely.
  const expectedHex = await downloadChecksum(checksumUrl, {
    fetch: opts.fetch,
  });

  const exists = opts.exists ?? existsSync;
  if (exists(dest)) {
    let localHex: string | null = null;
    let localBytes = 0;
    try {
      const local = readFileSync(dest);
      localBytes = local.byteLength;
      localHex = (await sha256Digest(local)).toString("hex");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // An unreadable/corrupt local binary is exactly when an update helps:
      // warn, then fall through to the full download.
      writeErr(
        `cannot hash the installed binary at ${dest} (${msg}); downloading the full asset`,
      );
    }
    if (localHex === expectedHex) {
      writeOut(
        `already up to date (${dest}, sha256 ${expectedHex.slice(0, 8)}…)`,
      );
      return {
        dest,
        bytes: localBytes,
        lastModified: null,
        updated: false,
      };
    }
  }

  writeErr(`downloading ${asset}`);
  const { bytes, lastModified } = await downloadAsset(url, {
    fetch: opts.fetch,
    minBytes: opts.minBytes,
  });
  await verifySha256(bytes, expectedHex, url);
  atomicReplaceBinary(dest, bytes);

  const extra = lastModified ? `, ${lastModified}` : "";
  writeOut(`updated ${dest} (${formatByteSize(bytes.byteLength)}${extra})`);
  return { dest, bytes: bytes.byteLength, lastModified, updated: true };
}

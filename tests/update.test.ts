import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INSTALL_BASE,
  MAX_REDIRECTS,
  MIN_BINARY_BYTES,
  assetUrl,
  atomicReplaceBinary,
  detectAsset,
  downloadAsset,
  formatByteSize,
  installBase,
  looksLikeInstalledSwapBinary,
  parseSha256Manifest,
  resolveUpdateDest,
  runUpdate,
} from "../src/update.ts";

const ROOT = `${import.meta.dir}/..`;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "swap-update-"));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("detectAsset", () => {
  test("maps process.platform + process.arch", () => {
    expect(detectAsset("darwin", "arm64")).toBe("swap-darwin-arm64");
    expect(detectAsset("darwin", "x64")).toBe("swap-darwin-x64");
    expect(detectAsset("linux", "arm64")).toBe("swap-linux-arm64");
    expect(detectAsset("linux", "x64")).toBe("swap-linux-x64");
  });

  test("maps uname-style arch names like install.sh", () => {
    expect(detectAsset("Linux", "x86_64")).toBe("swap-linux-x64");
    expect(detectAsset("Linux", "amd64")).toBe("swap-linux-x64");
    expect(detectAsset("Darwin", "aarch64")).toBe("swap-darwin-arm64");
  });

  test("rejects Windows like install.sh", () => {
    expect(() => detectAsset("win32", "x64")).toThrow(/Windows is not supported/);
    expect(() => detectAsset("mingw64", "x64")).toThrow(/Windows is not supported/);
    expect(() => detectAsset("msys", "x64")).toThrow(/Windows is not supported/);
  });

  test("rejects unknown OS and arch", () => {
    expect(() => detectAsset("freebsd", "x64")).toThrow(/unsupported OS/);
    expect(() => detectAsset("linux", "riscv64")).toThrow(/unsupported architecture/);
  });
});

describe("looksLikeInstalledSwapBinary", () => {
  test("compiled swap binary yes; bun/node no", () => {
    expect(looksLikeInstalledSwapBinary("/home/u/.local/bin/swap")).toBe(true);
    expect(looksLikeInstalledSwapBinary("/mnt/c/Users/u/swap.exe")).toBe(true);
    expect(looksLikeInstalledSwapBinary("/usr/bin/bun")).toBe(false);
    expect(looksLikeInstalledSwapBinary("/usr/local/bin/node")).toBe(false);
    expect(looksLikeInstalledSwapBinary("/usr/bin/bun.exe")).toBe(false);
    expect(looksLikeInstalledSwapBinary("/tmp/swap-linux-x64")).toBe(false);
  });
});

describe("resolveUpdateDest", () => {
  test("prefers execPath when it is an installed swap binary", () => {
    const dest = "/home/u/.local/bin/swap";
    expect(
      resolveUpdateDest({
        execPath: dest,
        env: { SWAP_INSTALL_DIR: "/opt/elsewhere" },
        homedir: "/home/u",
        exists: (p) => p === dest,
      }),
    ).toBe(dest);
  });

  test("falls back to SWAP_INSTALL_DIR/swap when running under bun", () => {
    expect(
      resolveUpdateDest({
        execPath: "/usr/bin/bun",
        env: { SWAP_INSTALL_DIR: "/opt/bin" },
        homedir: "/home/u",
        exists: (p) => p === "/opt/bin/swap",
      }),
    ).toBe("/opt/bin/swap");
  });

  test("falls back to ~/.local/bin/swap", () => {
    expect(
      resolveUpdateDest({
        execPath: "/usr/local/bin/node",
        env: {},
        homedir: "/home/u",
        exists: (p) => p === "/home/u/.local/bin/swap",
      }),
    ).toBe("/home/u/.local/bin/swap");
  });

  test("fails loudly when dest is missing", () => {
    expect(() =>
      resolveUpdateDest({
        execPath: "/usr/bin/bun",
        env: { SWAP_INSTALL_DIR: "/empty" },
        homedir: "/home/u",
        exists: () => false,
      }),
    ).toThrow(/no installed swap binary found at \/empty\/swap/);
  });

  test("fails loudly when execPath swap is missing", () => {
    expect(() =>
      resolveUpdateDest({
        execPath: "/opt/swap",
        env: {},
        homedir: "/home/u",
        exists: () => false,
      }),
    ).toThrow(/installed swap binary not found at \/opt\/swap/);
  });

  test("refuses a Cellar path", () => {
    const dest = "/opt/homebrew/Cellar/swap/0.1.0/bin/swap";
    expect(() =>
      resolveUpdateDest({
        execPath: dest,
        env: {},
        homedir: "/home/u",
        exists: (p) => p === dest,
      }),
    ).toThrow(
      /refusing to overwrite a Homebrew Cellar path[\s\S]*install\.sh/,
    );
  });

  test("accepts a curl install that merely lives under the brew prefix", () => {
    const dest = "/usr/local/bin/swap";
    expect(
      resolveUpdateDest({
        execPath: dest,
        env: { HOMEBREW_PREFIX: "/usr/local" },
        homedir: "/home/u",
        exists: (p) => p === dest,
      }),
    ).toBe(dest);
  });
});

describe("assetUrl", () => {
  test("default base is the stable /cli redirect", () => {
    expect(DEFAULT_INSTALL_BASE).toBe("https://swap.9summits.io/cli");
  });

  test("default base matches install.sh", () => {
    expect(assetUrl("swap-linux-x64", {})).toBe(
      `${DEFAULT_INSTALL_BASE}/swap-linux-x64`,
    );
  });

  test("honors SWAP_INSTALL_BASE and strips trailing slashes", () => {
    expect(
      assetUrl("swap-darwin-arm64", {
        SWAP_INSTALL_BASE: "https://example.test/cli///",
      }),
    ).toBe("https://example.test/cli/swap-darwin-arm64");
  });

  test("rejects http SWAP_INSTALL_BASE", () => {
    expect(() =>
      installBase({ SWAP_INSTALL_BASE: "http://evil.test/cli" }),
    ).toThrow(/SWAP_INSTALL_BASE must be an https URL/);
    expect(() =>
      assetUrl("swap-linux-x64", { SWAP_INSTALL_BASE: "http://evil.test/cli" }),
    ).toThrow(/SWAP_INSTALL_BASE must be an https URL/);
  });
});

describe("parseSha256Manifest", () => {
  test("takes the first token, lowercases, and requires 64 hex chars", () => {
    const hex = "ab".repeat(32);
    expect(
      parseSha256Manifest(`  ${hex.toUpperCase()}  swap-linux-x64\n`, "https://x.sha256"),
    ).toBe(hex);
  });

  test("names the checksum URL when the body is not a digest", () => {
    expect(() =>
      parseSha256Manifest("nope", "https://cdn.example/cli/x.sha256"),
    ).toThrow(
      /checksum at https:\/\/cdn.example\/cli\/x.sha256 is not a 64-char SHA-256 hex digest/,
    );
  });
});

describe("formatByteSize", () => {
  test("formats B / KB / MB", () => {
    expect(formatByteSize(12)).toBe("12 B");
    expect(formatByteSize(2048)).toBe("2 KB");
    expect(formatByteSize(1_048_576)).toBe("1.0 MB");
  });
});

describe("downloadAsset", () => {
  test("follows https redirects, fails on non-2xx, empty, and tiny body", async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetch404: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        redirect: init?.redirect,
      });
      return new Response("nope", { status: 404, statusText: "Not Found" });
    };
    await expect(
      downloadAsset("https://example.test/cli/swap-linux-x64", {
        fetch: fetch404,
        minBytes: 1,
      }),
    ).rejects.toThrow(/HTTP 404/);

    const moved = new Uint8Array([5, 6, 7, 8]);
    const fetch302: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        redirect: init?.redirect,
      });
      if (String(input) === "https://example.test/cli/x") {
        return new Response("", {
          status: 302,
          statusText: "Found",
          headers: { location: "https://blob.test/cli/x" },
        });
      }
      return new Response(moved, { status: 200 });
    };
    const followed = await downloadAsset("https://example.test/cli/x", {
      fetch: fetch302,
      minBytes: 1,
    });
    expect(followed.bytes).toEqual(moved);
    expect(calls.map((c) => c.url)).toContain("https://blob.test/cli/x");

    const empty: typeof fetch = async () =>
      new Response(new Uint8Array(), { status: 200 });
    await expect(
      downloadAsset("https://example.test/cli/x", { fetch: empty, minBytes: 1 }),
    ).rejects.toThrow(/empty/);

    const tiny: typeof fetch = async () =>
      new Response(new Uint8Array(16), { status: 200 });
    await expect(
      downloadAsset("https://example.test/cli/x", { fetch: tiny }),
    ).rejects.toThrow(new RegExp(`only 16 bytes`));
    expect(MIN_BINARY_BYTES).toBe(1_000_000);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  test("refuses a redirect that drops to http", async () => {
    const toHttp: typeof fetch = async () =>
      new Response("", {
        status: 302,
        statusText: "Found",
        headers: { location: "http://evil.test/swap" },
      });
    await expect(
      downloadAsset("https://example.test/cli/x", {
        fetch: toHttp,
        minBytes: 1,
      }),
    ).rejects.toThrow(
      /refusing redirect to non-https URL http:\/\/evil\.test\/swap while downloading https:\/\/example\.test\/cli\/x/,
    );
  });

  test("gives up after MAX_REDIRECTS hops", async () => {
    let hops = 0;
    const loop: typeof fetch = async () => {
      hops += 1;
      return new Response("", {
        status: 307,
        headers: { location: `https://example.test/cli/hop${hops}` },
      });
    };
    await expect(
      downloadAsset("https://example.test/cli/x", { fetch: loop, minBytes: 1 }),
    ).rejects.toThrow(
      /too many redirects .* while downloading https:\/\/example\.test\/cli\/x/,
    );
    expect(hops).toBe(MAX_REDIRECTS + 1);
  });

  test("rejects a redirect with no location header", async () => {
    const noLocation: typeof fetch = async () =>
      new Response("", { status: 302, statusText: "Found" });
    await expect(
      downloadAsset("https://example.test/cli/x", {
        fetch: noLocation,
        minBytes: 1,
      }),
    ).rejects.toThrow(
      /redirect from https:\/\/example\.test\/cli\/x has no location header \(HTTP 302\)/,
    );
  });

  test("rejects a redirect with an unparseable location", async () => {
    const junk: typeof fetch = async () =>
      new Response("", {
        status: 302,
        statusText: "Found",
        headers: { location: "https://[not-a-host" },
      });
    await expect(
      downloadAsset("https://example.test/cli/x", { fetch: junk, minBytes: 1 }),
    ).rejects.toThrow(/unparseable location https:\/\/\[not-a-host/);
  });

  test("verifies the checksum across a two-hop https chain", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      const payload = new Uint8Array(64).fill(3);
      const hex = await sha256Hex(payload);
      const redirects: Array<RequestRedirect | undefined> = [];
      const chain: typeof fetch = async (input, init) => {
        const u = String(input);
        redirects.push(init?.redirect);
        if (u.startsWith("https://swap.test/cli/")) {
          return new Response("", {
            status: 307,
            headers: {
              location: u.replace("https://swap.test", "https://blob.test"),
            },
          });
        }
        if (u.startsWith("https://blob.test/cli/")) {
          return new Response("", {
            status: 302,
            headers: {
              location: u.replace("https://blob.test", "https://release.test"),
            },
          });
        }
        if (u === "https://release.test/cli/swap-linux-x64.sha256") {
          return new Response(`${hex}  swap-linux-x64\n`, { status: 200 });
        }
        if (u === "https://release.test/cli/swap-linux-x64") {
          return new Response(payload, { status: 200 });
        }
        return new Response("nope", { status: 404, statusText: "Not Found" });
      };
      const result = await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://swap.test/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: chain,
        minBytes: 1,
        stdout: () => {},
        stderr: () => {},
      });
      expect(result.updated).toBe(true);
      expect(result.bytes).toBe(64);
      expect(readFileSync(dest)).toEqual(payload);
      expect(redirects.every((r) => r === "manual")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns body and Last-Modified on 200", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const ok: typeof fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { "Last-Modified": "Wed, 01 Jan 2026 00:00:00 GMT" },
      });
    const r = await downloadAsset("https://example.test/cli/x", {
      fetch: ok,
      minBytes: 1,
    });
    expect(r.bytes).toEqual(body);
    expect(r.lastModified).toBe("Wed, 01 Jan 2026 00:00:00 GMT");
  });
});

describe("atomicReplaceBinary", () => {
  test("replaces dest without leaving a temp file", () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old");
      atomicReplaceBinary(dest, new Uint8Array([110, 101, 119])); // "new"
      expect(readFileSync(dest, "utf8")).toBe("new");
      expect((statSync(dest).mode & 0o111) !== 0).toBe(true);
      const leftovers = readdirSync(dir).filter((f) =>
        f.startsWith(".swap-update."),
      );
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runUpdate", () => {
  test("downloads matching asset and replaces dest", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      const payload = new Uint8Array(32).fill(7);
      const hex = await sha256Hex(payload);
      const urls: string[] = [];
      const redirects: Array<RequestRedirect | undefined> = [];
      const fetchMock: typeof fetch = async (input, init) => {
        const u = String(input);
        urls.push(u);
        redirects.push(init?.redirect);
        if (u === "https://cdn.example/cli/swap-linux-x64.sha256") {
          return new Response(`${hex}\n`, { status: 200 });
        }
        if (u === "https://cdn.example/cli/swap-linux-x64") {
          return new Response(payload, {
            status: 200,
            headers: { "Last-Modified": "Thu, 01 Jan 2026 12:00:00 GMT" },
          });
        }
        return new Response("nope", { status: 404, statusText: "Not Found" });
      };
      const lines: string[] = [];
      const result = await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://cdn.example/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: fetchMock,
        minBytes: 1,
        stdout: (l) => lines.push("out:" + l),
        stderr: (l) => lines.push("err:" + l),
      });
      expect(urls).toContain("https://cdn.example/cli/swap-linux-x64");
      expect(urls).toContain("https://cdn.example/cli/swap-linux-x64.sha256");
      expect(redirects.every((r) => r === "manual")).toBe(true);
      expect(result.dest).toBe(dest);
      expect(result.bytes).toBe(32);
      expect(result.updated).toBe(true);
      expect(readFileSync(dest)).toEqual(payload);
      expect(lines.some((l) => l.startsWith("err:downloading swap-linux-x64"))).toBe(
        true,
      );
      expect(
        lines.some((l) =>
          l.startsWith(`out:updated ${dest} (32 B, Thu, 01 Jan 2026 12:00:00 GMT)`),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips the binary download when dest already matches the manifest", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      const installed = new Uint8Array(32).fill(7);
      writeFileSync(dest, installed);
      chmodSync(dest, 0o755);
      const hex = await sha256Hex(installed);
      const urls: string[] = [];
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        urls.push(u);
        if (u === "https://cdn.example/cli/swap-linux-x64.sha256") {
          return new Response(`${hex}\n`, { status: 200 });
        }
        return new Response("nope", { status: 404, statusText: "Not Found" });
      };
      const lines: string[] = [];
      const result = await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://cdn.example/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: fetchMock,
        minBytes: 1,
        stdout: (l) => lines.push("out:" + l),
        stderr: (l) => lines.push("err:" + l),
      });
      expect(urls).toEqual(["https://cdn.example/cli/swap-linux-x64.sha256"]);
      expect(result.updated).toBe(false);
      expect(result.dest).toBe(dest);
      expect(result.bytes).toBe(32);
      expect(result.lastModified).toBe(null);
      expect(readFileSync(dest)).toEqual(installed);
      expect(lines).toContain(
        `out:already up to date (${dest}, sha256 ${hex.slice(0, 8)}…)`,
      );
      expect(lines.some((l) => l.startsWith("err:downloading"))).toBe(false);
      expect(
        readdirSync(dir).filter((f) => f.startsWith(".swap-update.")),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("downloads when the installed binary differs from the manifest", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, new Uint8Array(32).fill(1));
      chmodSync(dest, 0o755);
      const payload = new Uint8Array(32).fill(7);
      const hex = await sha256Hex(payload);
      const urls: string[] = [];
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        urls.push(u);
        if (u === "https://cdn.example/cli/swap-linux-x64.sha256") {
          return new Response(`${hex}\n`, { status: 200 });
        }
        if (u === "https://cdn.example/cli/swap-linux-x64") {
          return new Response(payload, { status: 200 });
        }
        return new Response("nope", { status: 404, statusText: "Not Found" });
      };
      const lines: string[] = [];
      const result = await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://cdn.example/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: fetchMock,
        minBytes: 1,
        stdout: (l) => lines.push("out:" + l),
        stderr: (l) => lines.push("err:" + l),
      });
      expect(urls).toContain("https://cdn.example/cli/swap-linux-x64");
      expect(result.updated).toBe(true);
      expect(readFileSync(dest)).toEqual(payload);
      expect(lines.some((l) => l.startsWith("err:downloading swap-linux-x64"))).toBe(
        true,
      );
      expect(lines.some((l) => l.startsWith("out:already up to date"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("warns and downloads when the installed binary cannot be hashed", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      const payload = new Uint8Array(32).fill(7);
      const hex = await sha256Hex(payload);
      const urls: string[] = [];
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        urls.push(u);
        if (u === "https://cdn.example/cli/swap-linux-x64.sha256") {
          return new Response(`${hex}\n`, { status: 200 });
        }
        if (u === "https://cdn.example/cli/swap-linux-x64") {
          return new Response(payload, { status: 200 });
        }
        return new Response("nope", { status: 404, statusText: "Not Found" });
      };
      const lines: string[] = [];
      // dest reports as present but cannot be read: the update must still run.
      const result = await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://cdn.example/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: fetchMock,
        exists: () => true,
        minBytes: 1,
        stdout: (l) => lines.push("out:" + l),
        stderr: (l) => lines.push("err:" + l),
      });
      expect(
        lines.some((l) =>
          l.startsWith(`err:cannot hash the installed binary at ${dest}`),
        ),
      ).toBe(true);
      expect(urls).toContain("https://cdn.example/cli/swap-linux-x64");
      expect(result.updated).toBe(true);
      expect(readFileSync(dest)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not fetch when dest is missing", async () => {
    const cwd = tmpDir();
    try {
      let fetched = false;
      const fetchMock: typeof fetch = async () => {
        fetched = true;
        return new Response(new Uint8Array(8), { status: 200 });
      };
      await expect(
        runUpdate({
          execPath: "/usr/bin/bun",
          env: { SWAP_INSTALL_DIR: "/no/such/swap-install" },
          cwd,
          platform: "linux",
          arch: "x64",
          fetch: fetchMock,
          exists: () => false,
          minBytes: 1,
        }),
      ).rejects.toThrow(/no installed swap binary/);
      expect(fetched).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("checksum mismatch refuses to replace dest", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      const payload = new Uint8Array(32).fill(7);
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        if (u.endsWith(".sha256")) {
          return new Response(`${"0".repeat(64)}\n`, { status: 200 });
        }
        return new Response(payload, { status: 200 });
      };
      await expect(
        runUpdate({
          execPath: "/usr/bin/bun",
          env: {
            SWAP_INSTALL_DIR: dir,
            SWAP_INSTALL_BASE: "https://cdn.example/cli",
          },
          cwd: dir,
          platform: "linux",
          arch: "x64",
          fetch: fetchMock,
          minBytes: 1,
          stdout: () => {},
          stderr: () => {},
        }),
      ).rejects.toThrow(/checksum mismatch for https:\/\/cdn.example\/cli\/swap-linux-x64/);
      expect(readFileSync(dest, "utf8")).toBe("old-binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing checksum refuses to replace dest", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      const payload = new Uint8Array(32).fill(7);
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        if (u.endsWith(".sha256")) {
          return new Response("missing", { status: 404, statusText: "Not Found" });
        }
        return new Response(payload, { status: 200 });
      };
      await expect(
        runUpdate({
          execPath: "/usr/bin/bun",
          env: {
            SWAP_INSTALL_DIR: dir,
            SWAP_INSTALL_BASE: "https://cdn.example/cli",
          },
          cwd: dir,
          platform: "linux",
          arch: "x64",
          fetch: fetchMock,
          minBytes: 1,
          stdout: () => {},
          stderr: () => {},
        }),
      ).rejects.toThrow(
        /SHA-256 manifest missing or unreadable at https:\/\/cdn.example\/cli\/swap-linux-x64.sha256:.*HTTP 404/,
      );
      expect(readFileSync(dest, "utf8")).toBe("old-binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable checksum refuses to replace dest", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      const payload = new Uint8Array(32).fill(7);
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        if (u.endsWith(".sha256")) {
          return new Response("not a digest at all\n", { status: 200 });
        }
        return new Response(payload, { status: 200 });
      };
      await expect(
        runUpdate({
          execPath: "/usr/bin/bun",
          env: {
            SWAP_INSTALL_DIR: dir,
            SWAP_INSTALL_BASE: "https://cdn.example/cli",
          },
          cwd: dir,
          platform: "linux",
          arch: "x64",
          fetch: fetchMock,
          minBytes: 1,
          stdout: () => {},
          stderr: () => {},
        }),
      ).rejects.toThrow(
        /checksum at https:\/\/cdn.example\/cli\/swap-linux-x64.sha256 is not a 64-char SHA-256 hex digest/,
      );
      expect(readFileSync(dest, "utf8")).toBe("old-binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores SWAP_INSTALL_BASE when it matches a cwd .env file", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      writeFileSync(
        join(dir, ".env"),
        "SWAP_INSTALL_BASE=https://evil.example/cli\n",
      );
      const payload = new Uint8Array(32).fill(9);
      const hex = await sha256Hex(payload);
      const urls: string[] = [];
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        urls.push(u);
        if (!u.startsWith(DEFAULT_INSTALL_BASE)) {
          return new Response("blocked", { status: 599, statusText: "blocked" });
        }
        if (u.endsWith(".sha256")) {
          return new Response(`${hex}\n`, { status: 200 });
        }
        return new Response(payload, { status: 200 });
      };
      const lines: string[] = [];
      await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://evil.example/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: fetchMock,
        minBytes: 1,
        stdout: () => {},
        stderr: (l) => lines.push(l),
      });
      expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
      expect(urls).toContain(`${DEFAULT_INSTALL_BASE}/swap-linux-x64`);
      expect(urls).toContain(`${DEFAULT_INSTALL_BASE}/swap-linux-x64.sha256`);
      expect(readFileSync(dest)).toEqual(payload);
      expect(lines).toContain(
        "ignoring SWAP_INSTALL_BASE from a .env file in the current directory",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps shell SWAP_INSTALL_BASE when it differs from cwd .env", async () => {
    const dir = tmpDir();
    try {
      const dest = join(dir, "swap");
      writeFileSync(dest, "old-binary");
      chmodSync(dest, 0o755);
      writeFileSync(
        join(dir, ".env"),
        "SWAP_INSTALL_BASE=https://evil.example/cli\n",
      );
      const payload = new Uint8Array(32).fill(3);
      const hex = await sha256Hex(payload);
      const urls: string[] = [];
      const fetchMock: typeof fetch = async (input) => {
        const u = String(input);
        urls.push(u);
        if (u === "https://cdn.example/cli/swap-linux-x64.sha256") {
          return new Response(`${hex}\n`, { status: 200 });
        }
        if (u === "https://cdn.example/cli/swap-linux-x64") {
          return new Response(payload, { status: 200 });
        }
        return new Response("nope", { status: 404, statusText: "Not Found" });
      };
      await runUpdate({
        execPath: "/usr/bin/bun",
        env: {
          SWAP_INSTALL_DIR: dir,
          SWAP_INSTALL_BASE: "https://cdn.example/cli",
        },
        cwd: dir,
        platform: "linux",
        arch: "x64",
        fetch: fetchMock,
        minBytes: 1,
        stdout: () => {},
        stderr: () => {},
      });
      expect(urls).toContain("https://cdn.example/cli/swap-linux-x64");
      expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
      expect(readFileSync(dest)).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI intercepts update before commander", () => {
  test("swap update with missing dest fails before required <amount>", async () => {
    const dir = tmpDir();
    try {
      const proc = Bun.spawn(["bun", "run", "src/index.ts", "update"], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SWAP_INSTALL_DIR: dir },
        signal: AbortSignal.timeout(20_000),
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      const all = stdout + stderr;
      expect(code).toBe(1);
      expect(all).toMatch(/no installed swap binary found/);
      expect(all).not.toMatch(/required argument/i);
      expect(all).not.toMatch(/<amount>/);
      expect(existsSync(join(dir, "swap"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cwd .env SWAP_INSTALL_BASE still fails on missing dest, not commander", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, ".env"),
        "SWAP_INSTALL_BASE=http://evil.example/cli\n",
      );
      const proc = Bun.spawn(["bun", join(ROOT, "src/index.ts"), "update"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SWAP_INSTALL_DIR: dir },
        signal: AbortSignal.timeout(20_000),
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      const all = stdout + stderr;
      expect(code).toBe(1);
      expect(all).toMatch(/no installed swap binary found/);
      expect(all).not.toMatch(/required argument/i);
      expect(all).not.toMatch(/<amount>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

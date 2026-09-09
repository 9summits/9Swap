// Persistent token-icon cache.
//
// `/api/icon` is already CDN-cached, but every dApp load still remounts <img>
// tags and the picker paints empty coins until each image decodes again. This
// module keeps decoded blobs around:
//   • memory Map (object URLs) — remounts in the same session are sync
//   • Cache Storage — survives reloads; hydrated into the Map on boot
//
// Only same-origin URLs (the /api/icon proxy) are stored. Third-party
// fallbacks (1inch, TrustWallet) are CORS-opaque from fetch() and stay as
// plain <img src>. Failures are logged, never thrown — a cache miss just
// means the <img> hits the network.

const CACHE_NAME = "swap-token-icons-v1";
const STORE_ORIGIN = "https://token-icon.local";

const mem = new Map<string, string | null>();
const persisting = new Map<string, Promise<void>>();
let hydrateOnce: Promise<void> | undefined;

export function iconKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** Sync lookup. `undefined` = not yet known, `null` = every candidate missed. */
export function peekIcon(key: string): string | null | undefined {
  if (!mem.has(key)) return undefined;
  return mem.get(key);
}

export function rememberIcon(key: string, src: string | null): void {
  const prev = mem.get(key);
  if (typeof prev === "string" && prev.startsWith("blob:") && prev !== src) {
    URL.revokeObjectURL(prev);
  }
  mem.set(key, src);
}

export function forgetIcon(key: string): void {
  const prev = mem.get(key);
  if (typeof prev === "string" && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
  mem.delete(key);
  const api = cacheApi();
  if (!api) return;
  void api
    .open(CACHE_NAME)
    .then((cache) => cache.delete(storedUrl(key)))
    .catch((e) => {
      console.warn("iconCache: delete failed", e);
    });
}

export function isPersistableIconUrl(src: string): boolean {
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) return false;
  if (src.startsWith("/")) return true;
  if (typeof location === "undefined") return false;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

export function hydrateIconCache(): Promise<void> {
  hydrateOnce ??= doHydrate();
  return hydrateOnce;
}

export function persistIconFromUrl(key: string, src: string): Promise<void> {
  const existing = persisting.get(key);
  if (existing) return existing;
  const run = persistUnguarded(key, src).finally(() => persisting.delete(key));
  persisting.set(key, run);
  return run;
}

void hydrateIconCache();

function cacheApi(): CacheStorage | null {
  try {
    return typeof caches === "undefined" ? null : caches;
  } catch {
    return null;
  }
}

function storedUrl(key: string): string {
  return `${STORE_ORIGIN}/${encodeURIComponent(key)}`;
}

function keyFromStoredRequest(req: Request): string | null {
  try {
    const path = new URL(req.url).pathname.slice(1);
    return path ? decodeURIComponent(path) : null;
  } catch (e) {
    console.warn("iconCache: bad stored key", e);
    return null;
  }
}

async function doHydrate(): Promise<void> {
  const api = cacheApi();
  if (!api) return;
  try {
    const cache = await api.open(CACHE_NAME);
    const reqs = await cache.keys();
    for (const req of reqs) {
      const key = keyFromStoredRequest(req);
      if (!key || mem.has(key)) continue;
      const res = await cache.match(req);
      if (!res) continue;
      const blob = await res.blob();
      if (blob.size === 0) continue;
      mem.set(key, URL.createObjectURL(blob));
    }
  } catch (e) {
    console.warn("iconCache: hydrate failed", e);
  }
}

async function persistUnguarded(key: string, src: string): Promise<void> {
  const already = mem.get(key);
  if (typeof already === "string" && already.startsWith("blob:")) return;
  if (!isPersistableIconUrl(src)) {
    rememberIcon(key, src);
    return;
  }
  try {
    const res = await fetch(src);
    if (!res.ok) {
      rememberIcon(key, src);
      return;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      rememberIcon(key, src);
      return;
    }
    await storeBlob(key, await res.blob());
  } catch (e) {
    console.warn("iconCache: persist failed", e);
    rememberIcon(key, src);
  }
}

async function storeBlob(key: string, blob: Blob): Promise<void> {
  rememberIcon(key, URL.createObjectURL(blob));
  const api = cacheApi();
  if (!api) return;
  try {
    const cache = await api.open(CACHE_NAME);
    await cache.put(
      storedUrl(key),
      new Response(blob, { headers: { "content-type": blob.type || "image/png" } }),
    );
  } catch (e) {
    console.warn("iconCache: store failed", e);
  }
}

if (import.meta.main) {
  const eq = (a: unknown, b: unknown, msg: string) => {
    if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(iconKey(1, "0xABC"), "1:0xabc", "iconKey lowercases");
  eq(isPersistableIconUrl("/api/icon?chain=eth&address=0xabc"), true, "relative proxy");
  eq(isPersistableIconUrl("blob:http://localhost/1"), false, "blob");
  eq(isPersistableIconUrl("https://tokens.1inch.io/0xabc.png"), false, "third-party");
  eq(peekIcon("missing"), undefined, "unknown key");
  rememberIcon("k", "/api/icon?x=1");
  eq(peekIcon("k"), "/api/icon?x=1", "remember");
  forgetIcon("k");
  eq(peekIcon("k"), undefined, "forget");
  console.log("iconCache self-check: OK");
}

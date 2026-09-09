// Token price oracle for the simulation block. Uses Alchemy's prices
// API (already required for -d/--simu) — keyless CoinGecko falls back
// only if Alchemy returns nothing useful.
//
// Returns USD per *single token* (not for amountIn). Multiply by the
// human-units amount at the call site. Caches per (chainId, address)
// for the CLI lifetime — token prices don't move enough across the
// few seconds a swap session lives that we need fresher data.

import type { ChainInfo } from "./chains.ts";
import { NATIVE_SENTINEL } from "./tokens.ts";

type CacheKey = string; // `${chainId}:${address.toLowerCase()}`
const cache = new Map<CacheKey, Promise<number | null>>();

function keyFor(chain: ChainInfo, addr: string): CacheKey {
  return `${chain.chainId}:${addr.toLowerCase()}`;
}

// Alchemy's prices API takes a `network` field that's the same
// subdomain we use elsewhere (`eth-mainnet`, `bnb-mainnet`, …). Not
// every chain in our table has prices coverage; null = skip.
function alchemyNetwork(chain: ChainInfo): string | null {
  return chain.alchemySubdomain;
}

async function fetchAlchemyByAddress(
  apiKey: string,
  network: string,
  address: string,
): Promise<number | null> {
  const url = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-address`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ addresses: [{ network, address }] }),
    });
  } catch (err) {
    console.error(
      `! prices: alchemy by-address fetch failed: ${(err as Error).message}`,
    );
    return null;
  }
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: Array<{
      prices?: Array<{ currency?: string; value?: string }>;
    }>;
  };
  const prices = json.data?.[0]?.prices ?? [];
  for (const p of prices) {
    if (p.currency === "usd" && p.value) {
      const n = Number(p.value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

async function fetchAlchemyBySymbol(
  apiKey: string,
  symbol: string,
): Promise<number | null> {
  const url = `https://api.g.alchemy.com/prices/v1/${apiKey}/tokens/by-symbol?symbols=${encodeURIComponent(symbol)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    console.error(
      `! prices: alchemy by-symbol fetch failed: ${(err as Error).message}`,
    );
    return null;
  }
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: Array<{
      prices?: Array<{ currency?: string; value?: string }>;
    }>;
  };
  const prices = json.data?.[0]?.prices ?? [];
  for (const p of prices) {
    if (p.currency === "usd" && p.value) {
      const n = Number(p.value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

export async function fetchTokenPriceUsd(
  chain: ChainInfo,
  address: string,
): Promise<number | null> {
  const k = keyFor(chain, address);
  const hit = cache.get(k);
  if (hit) return hit;

  const apiKey = process.env.ALCHEMY_API_KEY;
  if (!apiKey) {
    cache.set(k, Promise.resolve(null));
    return null;
  }

  const promise = (async (): Promise<number | null> => {
    if (address.toLowerCase() === NATIVE_SENTINEL) {
      // Alchemy's by-symbol endpoint handles natives uniformly.
      return fetchAlchemyBySymbol(apiKey, chain.nativeSymbol);
    }
    const network = alchemyNetwork(chain);
    if (!network) return null;
    return fetchAlchemyByAddress(apiKey, network, address);
  })();
  cache.set(k, promise);
  return promise;
}

// Custom (user-imported) tokens — localStorage persistence + on-chain ERC20
// metadata lookup.
//
// When the normal resolution flow (curated list → POST /api/resolve-token)
// can't identify a pasted address, the dApp falls back to reading the ERC20's
// name/symbol/decimals directly on-chain through the USER's RPC (the connected
// wallet's provider when it sits on the selected chain, the chain's default
// public RPC otherwise — same policy as the balance reads; the server's RPC
// key is never consumed). A picked custom token is persisted per-chain in
// localStorage so it shows up in the selector on future visits. Settings'
// "Manage" control opens CustomTokensModal (all chains, CSV import/export).

import {
  createPublicClient,
  custom,
  erc20Abi,
  erc20Abi_bytes32,
  fallback,
  hexToString,
  http,
  type EIP1193Provider,
} from "viem";
import { knownChains } from "../wagmi";
import { CORS_OPEN_RPC } from "../publicRpc";
import type { TokenInfo } from "./types";
import { chainMetaForId, storedCustomTokensFromUnknown } from "./customTokensCsv";

export {
  chainMetaForAlias,
  chainMetaForId,
  CUSTOM_TOKEN_CHAINS,
  listedTokensToCsv,
  parseCustomTokensCsv,
  storedCustomTokensFromUnknown,
  tokensToCsv,
} from "./customTokensCsv";
export type {
  CsvParseError,
  CustomTokenChain,
  CustomTokenCsvRow,
  ParseCustomTokensCsvResult,
  ParsedCustomToken,
} from "./customTokensCsv";

const STORAGE_KEY = "swap.customTokens.v1";

// chainId (stringified — JSON keys) → tokens imported on that chain.
type Store = Record<string, TokenInfo[]>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    // Corrupt JSON / storage denied — treat as empty, never crash the picker.
    console.error("customTokens: failed to read store", e);
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (e) {
    console.error("customTokens: failed to persist store", e);
  }
}

export function listCustomTokens(chainId: number): TokenInfo[] {
  return storedCustomTokensFromUnknown(readStore())
    .filter((r) => r.chainId === chainId)
    .map((r) => r.token);
}

export type ListedCustomToken = {
  chainId: number;
  alias: string;
  chainName: string;
  token: TokenInfo;
};

// Every stored custom token across chains, sorted chainId → symbol → address.
export function listAllCustomTokens(): ListedCustomToken[] {
  return storedCustomTokensFromUnknown(readStore()).map((row) => {
    const meta = chainMetaForId(row.chainId);
    return {
      chainId: row.chainId,
      alias: meta?.alias ?? String(row.chainId),
      chainName: meta?.name ?? `chain ${row.chainId}`,
      token: row.token,
    };
  });
}

// Add (idempotent — replaces any prior entry at the same address).
export function addCustomToken(chainId: number, token: TokenInfo): void {
  const store = readStore();
  const key = String(chainId);
  const addr = token.address.toLowerCase();
  const rest = (store[key] ?? []).filter(
    (t) => t.address.toLowerCase() !== addr,
  );
  store[key] = [...rest, { ...token, address: addr }];
  writeStore(store);
}

export function removeCustomToken(chainId: number, address: string): void {
  const store = readStore();
  const key = String(chainId);
  const addr = address.toLowerCase();
  const next = (store[key] ?? []).filter(
    (t) => t.address.toLowerCase() !== addr,
  );
  if (next.length === 0) delete store[key];
  else store[key] = next;
  writeStore(store);
}

// symbol()/name() come from an ARBITRARY contract — the strings are attacker-
// controlled. Cap the length (a malicious token returning megabytes would
// freeze the picker's layout/filtering and poison the localStorage quota) and
// strip control + bidi-override characters (U+202E can visually reorder the
// symbol for spoofing). Empty after cleaning ⇒ treated as unreadable.
function sanitizeOnchainString(s: string): string | null {
  const cleaned = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, 64)
    .trim();
  return cleaned || null;
}

// Read name/symbol/decimals from the contract via the user's RPC. `decimals`
// is safety-critical (it scales the amount math), so its read failing fails
// the whole lookup; name/symbol degrade to a truncated address. Tokens with
// bytes32 metadata (MKR-style) get a second read via the bytes32 ABI.
export async function fetchErc20Meta(
  chainId: number,
  address: string,
  walletProvider?: EIP1193Provider,
): Promise<TokenInfo> {
  const chain = knownChains.find((c) => c.id === chainId);
  if (!chain) throw new Error(`no RPC client for chain ${chainId}`);
  // Lowercase before the reads: viem's strict EIP-55 check rejects a
  // mixed-case paste whose casing doesn't match the checksum (all-lowercase
  // bypasses it), and the codebase convention keys addresses lowercased.
  address = address.toLowerCase();
  // Transport order: wallet provider → CORS-open public RPC → viem's chain
  // default. The CORS-open hop matters for the no-wallet path: viem's defaults
  // (mainnet's eth.merkle.io notably) reject browser-origin requests.
  const corsUrl = CORS_OPEN_RPC[chainId];
  const transports = [
    ...(walletProvider ? [custom(walletProvider, { retryCount: 0 })] : []),
    ...(corsUrl ? [http(corsUrl)] : []),
    http(),
  ];
  const client = createPublicClient({
    chain,
    transport: transports.length > 1 ? fallback(transports) : transports[0]!,
  });
  const addr = address as `0x${string}`;

  const decimals = await client.readContract({
    address: addr,
    abi: erc20Abi,
    functionName: "decimals",
  });
  if (decimals < 0 || decimals > 36) {
    throw new Error(`implausible decimals ${decimals} for ${address}`);
  }

  const readString = async (fn: "symbol" | "name"): Promise<string | null> => {
    try {
      const s = await client.readContract({ address: addr, abi: erc20Abi, functionName: fn });
      return sanitizeOnchainString(s);
    } catch {
      try {
        const b32 = await client.readContract({
          address: addr,
          abi: erc20Abi_bytes32,
          functionName: fn,
        });
        const s = hexToString(b32, { size: 32 }).replace(/\0+$/, "");
        return sanitizeOnchainString(s);
      } catch (e) {
        console.error(`customTokens: ${fn}() read failed for ${address}`, e);
        return null;
      }
    }
  };

  const [symbol, name] = await Promise.all([readString("symbol"), readString("name")]);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return {
    address,
    symbol: symbol ?? short,
    name: name ?? "unknown token",
    decimals: Number(decimals),
  };
}

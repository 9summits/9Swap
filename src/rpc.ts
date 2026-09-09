import type { ChainInfo } from "./chains.ts";
import { CORS_OPEN_RPC } from "../shared/public_rpc.ts";

export class RpcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcConfigError";
  }
}

// Set by main() when the user passes `--rpc <url>` — sits at the top
// of the precedence chain, ahead of every env-based resolver. Keep it
// chain-agnostic: a one-shot CLI invocation is always single-chain, so
// one override slot is enough.
let rpcOverride: string | null = null;

export function setRpcOverride(url: string | null): void {
  rpcOverride = url;
}

// Set once at dApp handler load. CLI `-d` / `--simulate` / `--browser`
// never flip this, so they still hard-fail without Alchemy or an override.
let publicRpcFallback = false;
const loggedPublicFallback = new Set<number>();

export function setPublicRpcFallback(on: boolean): void {
  publicRpcFallback = on;
}

/** Tests only — production entry points set this and never clear it. */
export function resetPublicRpcFallback(): void {
  publicRpcFallback = false;
  loggedPublicFallback.clear();
}

export function getRpcUrl(chain: ChainInfo): string {
  const url = tryRpcUrl(chain);
  if (url) return url;

  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyKey) {
    throw new RpcConfigError(
      `no RPC configured for ${chain.displayName}. ` +
        `pass --rpc <url>, set ALCHEMY_API_KEY in .env (works across all supported chains), ` +
        `or provide ${chain.alias.toUpperCase()}_RPC_URL directly.`,
    );
  }

  throw new RpcConfigError(
    `Alchemy does not cover ${chain.displayName} with this CLI's mapping. ` +
      `pass --rpc <url> or set ${chain.alias.toUpperCase()}_RPC_URL (or RPC_URL_${chain.chainId}) to a direct RPC endpoint.`,
  );
}

// Soft variant: returns null instead of throwing when no RPC is
// configured. Use this from features that should degrade gracefully
// (allowance check, priorityFee, gas USD fallback) rather than abort
// the whole quote when the user hasn't set up a key yet.
export function tryRpcUrl(chain: ChainInfo): string | null {
  if (rpcOverride) return rpcOverride;

  const byChainId = process.env[`RPC_URL_${chain.chainId}`];
  if (byChainId) return byChainId;

  const byAlias = process.env[`${chain.alias.toUpperCase()}_RPC_URL`];
  if (byAlias) return byAlias;

  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (alchemyKey && chain.alchemySubdomain) {
    return `https://${chain.alchemySubdomain}.g.alchemy.com/v2/${alchemyKey}`;
  }

  if (publicRpcFallback) {
    const publicUrl = CORS_OPEN_RPC[chain.chainId];
    if (publicUrl) {
      if (!loggedPublicFallback.has(chain.chainId)) {
        loggedPublicFallback.add(chain.chainId);
        console.error(
          `! no Alchemy/override for ${chain.displayName}; using public RPC (${redactRpc(publicUrl)})`,
        );
      }
      return publicUrl;
    }
  }
  return null;
}

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);
  const json = (await res.json()) as RpcResponse<T>;
  if (json.error) throw new Error(`rpc: ${json.error.message}`);
  if (json.result === undefined) throw new Error("rpc: no result");
  return json.result;
}

function padLeft32(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export async function getAllowance(params: {
  rpc: string;
  token: string;
  owner: string;
  spender: string;
}): Promise<bigint> {
  const { rpc, token, owner, spender } = params;
  const data =
    "0xdd62ed3e" + padLeft32(owner) + padLeft32(spender);
  const result = await rpcCall<string>(rpc, "eth_call", [
    { to: token, data },
    "latest",
  ]);
  return BigInt(result);
}

export async function getErc20Decimals(params: {
  rpc: string;
  token: string;
}): Promise<number> {
  const { rpc, token } = params;
  const result = await rpcCall<string>(rpc, "eth_call", [
    { to: token, data: "0x313ce567" },
    "latest",
  ]);
  if (!result || result === "0x") {
    throw new Error(`decimals() returned empty — likely not an ERC20`);
  }
  const n = Number(BigInt(result));
  // ERC20 decimals is uint8; real tokens are 0..36. Anything larger is garbage.
  if (!Number.isInteger(n) || n < 0 || n > 36) {
    throw new Error(`decimals() returned implausible value: ${n}`);
  }
  return n;
}

export async function getErc20Balance(params: {
  rpc: string;
  token: string;
  owner: string;
}): Promise<bigint> {
  const { rpc, token, owner } = params;
  const data = "0x70a08231" + padLeft32(owner);
  const result = await rpcCall<string>(rpc, "eth_call", [
    { to: token, data },
    "latest",
  ]);
  return BigInt(result);
}

export async function getNativeBalance(
  rpc: string,
  owner: string,
): Promise<bigint> {
  const result = await rpcCall<string>(rpc, "eth_getBalance", [owner, "latest"]);
  return BigInt(result);
}

/** Host only. Alchemy keys live in the path; userinfo is also dropped. */
export function redactRpc(rpc: string): string {
  try {
    return new URL(rpc).host;
  } catch {
    return "unparseable-rpc";
  }
}

export async function getPriorityFee(rpc: string): Promise<bigint | null> {
  try {
    const result = await rpcCall<string>(rpc, "eth_maxPriorityFeePerGas", []);
    return BigInt(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `! priorityFee unavailable: ${msg} (rpc=${redactRpc(rpc)})`,
    );
    return null;
  }
}

export async function getGasPrice(rpc: string): Promise<bigint | null> {
  try {
    const result = await rpcCall<string>(rpc, "eth_gasPrice", []);
    return BigInt(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`! gasPrice unavailable: ${msg} (rpc=${redactRpc(rpc)})`);
    return null;
  }
}

export function buildApproveData(spender: string, amount: bigint): string {
  return (
    "0x095ea7b3" +
    padLeft32(spender) +
    amount.toString(16).padStart(64, "0")
  );
}

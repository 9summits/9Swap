// Picker snapshot of curated + custom + recent balances.
// Visitor RPC via publicClientFor — never the server's Alchemy.
// Pair watcher (tokenIn/tokenOut, per block) stays in InteractiveDapp.

import { erc20Abi, type EIP1193Provider } from "viem";
import { publicClientFor } from "../wagmi";
import { NATIVE_SENTINEL } from "./useQuote";
import type { BalanceMap } from "./tokenHoldings";

const CHUNK = 100;
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function asAddress(addr: string): `0x${string}` | null {
  return ADDR_RE.test(addr) ? (addr as `0x${string}`) : null;
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function readWalletBalances(p: {
  chainId: number;
  owner: `0x${string}`;
  tokens: readonly { address: string }[];
  walletProvider?: EIP1193Provider;
}): Promise<BalanceMap> {
  const client = publicClientFor(p.chainId, p.walletProvider);
  if (!client) {
    console.warn(`walletBalances: no public client for chain ${p.chainId}`);
    return {};
  }

  const seen = new Set<string>();
  let wantNative = false;
  const erc20: `0x${string}`[] = [];
  for (const t of p.tokens) {
    const lc = t.address.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    if (lc === NATIVE_SENTINEL) {
      wantNative = true;
      continue;
    }
    const addr = asAddress(t.address);
    if (!addr) {
      console.error(`walletBalances: skip invalid address ${t.address}`);
      continue;
    }
    erc20.push(addr);
  }

  const out: BalanceMap = {};

  const readNative = async () => {
    if (!wantNative) return;
    try {
      const bal = await client.getBalance({ address: p.owner });
      out[NATIVE_SENTINEL] = bal.toString();
    } catch (err) {
      console.error("walletBalances: native balance read failed", err);
    }
  };

  const readChunk = async (group: `0x${string}`[]) => {
    try {
      const results = await client.multicall({
        allowFailure: true,
        contracts: group.map((address) => ({
          address,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [p.owner],
        })),
      });
      results.forEach((r, i) => {
        const addr = group[i]!.toLowerCase();
        if (r.status === "success") out[addr] = r.result.toString();
        else console.error(`walletBalances: balanceOf failed for ${addr}`, r.error);
      });
    } catch (err) {
      console.error(
        "walletBalances: multicall failed, falling back to per-token reads",
        err,
      );
      const settled = await Promise.allSettled(
        group.map((address) =>
          client.readContract({
            address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [p.owner],
          }),
        ),
      );
      settled.forEach((r, i) => {
        const addr = group[i]!.toLowerCase();
        if (r.status === "fulfilled") out[addr] = r.value.toString();
        else console.error(`walletBalances: balanceOf failed for ${addr}`, r.reason);
      });
    }
  };

  await Promise.all([readNative(), ...chunk(erc20, CHUNK).map(readChunk)]);
  return out;
}

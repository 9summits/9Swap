// Native ↔ wrapped-native (WETH9-style) short-circuit. When tokenIn
// and tokenOut form the wrap/unwrap pair on a chain, we skip the
// venue-quote loop entirely and emit a direct deposit() / withdraw()
// tx — the rate is 1:1 by definition, no slippage, no aggregator fee.
//
// Detection happens in the orchestrator (src/index.ts) by comparing
// token addresses against `chain.wrappedNative` and the native
// sentinel. `synthQuote` produces the NormalizedQuote downstream
// renderers expect; `buildWrapTx` produces the NormalizedTx.

import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./venues/index.ts";
import { NATIVE_SENTINEL } from "./tokens.ts";
import { toChecksumAddress } from "./checksum.ts";

export type WrapMode = "wrap" | "unwrap";

// WETH9 (and every clone): deposit() pays-in via msg.value, withdraw(uint256)
// pays-out via raw call. Both selectors are stable across all WETH9
// deployments — we don't need to ABI-encode anything beyond withdraw's
// uint256 amount.
const SEL_DEPOSIT = "0xd0e30db0"; // deposit()
const SEL_WITHDRAW = "0x2e1a7d4d"; // withdraw(uint256)

export function detectWrap(args: {
  chain: ChainInfo;
  tokenInAddress: string;
  tokenOutAddress: string;
}): WrapMode | null {
  const wrapped = args.chain.wrappedNative.toLowerCase();
  const inLc = args.tokenInAddress.toLowerCase();
  const outLc = args.tokenOutAddress.toLowerCase();
  if (inLc === NATIVE_SENTINEL && outLc === wrapped) return "wrap";
  if (inLc === wrapped && outLc === NATIVE_SENTINEL) return "unwrap";
  return null;
}

// Synthetic quote — 1:1 rate, no gas estimate (depositors / withdrawers
// pay the L1 base fee ~28k–50k gas total; the renderer shows "—" when
// gasUnits is null, which is what we want here).
export function synthQuote(args: {
  chain: ChainInfo;
  mode: WrapMode;
  tokenInAddress: string;
  tokenOutAddress: string;
  amountIn: bigint;
}): NormalizedQuote {
  const exchange =
    args.mode === "wrap"
      ? `${args.chain.nativeSymbol} → W${args.chain.nativeSymbol} (deposit)`
      : `W${args.chain.nativeSymbol} → ${args.chain.nativeSymbol} (withdraw)`;
  const hops: NormalizedHop[] = [
    {
      tokenIn: args.tokenInAddress.toLowerCase(),
      tokenOut: args.tokenOutAddress.toLowerCase(),
      exchange,
      swapAmount: args.amountIn.toString(),
      pool: args.chain.wrappedNative.toLowerCase(),
    },
  ];
  return {
    // Pseudo-venue label. The Venue union doesn't include "wrap" because
    // the dispatcher never builds for it — the orchestrator detects
    // wrap/unwrap and synthesizes both quote and tx directly. Renderers
    // / JSON treat venue as a string label, so the cast is harmless at
    // runtime.
    venue: "wrap" as unknown as Venue,
    amountIn: args.amountIn.toString(),
    amountOut: args.amountIn.toString(), // 1:1 by construction
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: args.chain.wrappedNative,
    hops,
    tokenHints: new Map(),
    raw: { mode: args.mode, wrappedNative: args.chain.wrappedNative },
  };
}

export function buildWrapTx(args: {
  chain: ChainInfo;
  sender: string;
  amountIn: bigint;
  mode: WrapMode;
}): NormalizedTx {
  const wrapped = toChecksumAddress(args.chain.wrappedNative);
  if (args.mode === "wrap") {
    // deposit() — selector + msg.value carries the amount. No args.
    return {
      to: wrapped,
      from: args.sender,
      data: SEL_DEPOSIT,
      value: `0x${args.amountIn.toString(16)}`,
      gas: null,
      gasPrice: null,
      maxPriorityFeePerGas: null,
      // Spender is the WETH9 itself — but no ERC20 approval is needed
      // for either direction (deposit takes msg.value, withdraw operates
      // on the user's own WETH balance via msg.sender). The orchestrator
      // skips the allowance check when input is native; for unwrap we'd
      // have a WETH input, so we still expose `spender = WETH9` for the
      // approval-check code to target — and below, withdraw() operating
      // on msg.sender's own balance means the read returns balance
      // itself, not allowance. We dodge this by signaling "no approval
      // needed" via the sufficient flag in index.ts.
      spender: wrapped,
      chainId: args.chain.chainId,
    };
  }
  // withdraw(uint256) — selector + 32-byte amount.
  const amountHex = args.amountIn.toString(16).padStart(64, "0");
  return {
    to: wrapped,
    from: args.sender,
    data: SEL_WITHDRAW + amountHex,
    value: "0",
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    spender: wrapped,
    chainId: args.chain.chainId,
  };
}

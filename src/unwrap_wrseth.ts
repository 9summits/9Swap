// `--action unwrapwrseth` short-circuit. Burns Kelp DAO's wrsETH
// (the LayerZero-bridged wrapper) back into rsETH on Base — 1:1, no
// allowance, no slippage. Lives outside the venue dispatcher for the
// same reason wrap.ts / send.ts do: there's nothing to compare and
// nothing to route, so we skip the quote loop entirely.
//
// CLI: swap <amount> wrseth -a unwrapwrseth --chain base
//
// Mechanism: wrsETH at 0xEDfa…BEA0 (TransparentUpgradeableProxy →
// 0x0223…1494 impl) exposes `withdraw(address token, uint256 amount)`
// at selector 0xf3fef3a3 — pass (rsETH, amount), the contract burns
// the caller's wrsETH and pays out rsETH. The complementary
// `deposit(address,uint256)` at 0x47e7ef24 does the wrap leg, which
// we don't need to expose yet. No ERC20 approval is needed: the
// burn pulls from msg.sender's own balance.

import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./venues/index.ts";
import type { Token } from "./tokens.ts";
import { toChecksumAddress } from "./checksum.ts";

// Base chain id — this action is Base-only because that's the only
// chain where we have the Kelp wrapper deployment confirmed; other
// chains have their own wrsETH addresses with potentially different
// unwrap mechanics, so we don't generalize until asked.
export const BASE_CHAIN_ID = 8453;

// Kelp DAO addresses on Base. Both are 18 decimals.
export const WRSETH_BASE = "0xEDfa23602D0EC14714057867A78d01e94176BEA0";
export const RSETH_BASE = "0x1Bc71130A0e39942a7658878169764Bbd8A45993";

// withdraw(address token, uint256 amount). Burns msg.sender's wrsETH
// and returns `amount` of `token` (= rsETH for this action).
const SEL_WITHDRAW = "0xf3fef3a3";

function pad32Addr(a: string): string {
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function pad32Big(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

// Synthesizes a wrsETH Token entry from chain context — we don't go
// through the resolver because the user might pass any spelling
// ("wrseth", "wrsETH", the address, …) and we want the action to
// deterministically target Kelp's deployment.
export function makeWrsethToken(): Token {
  return {
    address: WRSETH_BASE,
    symbol: "wrsETH",
    name: "Wrapped rsETH",
    decimals: 18,
    chainId: BASE_CHAIN_ID,
    source: "hardcoded",
  };
}

export function makeRsethToken(): Token {
  return {
    address: RSETH_BASE,
    symbol: "rsETH",
    name: "Kelp DAO Restaked ETH",
    decimals: 18,
    chainId: BASE_CHAIN_ID,
    source: "hardcoded",
  };
}

export function synthUnwrapWrsethQuote(args: {
  amountIn: bigint;
}): NormalizedQuote {
  const hops: NormalizedHop[] = [
    {
      tokenIn: WRSETH_BASE.toLowerCase(),
      tokenOut: RSETH_BASE.toLowerCase(),
      exchange: "wrsETH → rsETH (withdraw)",
      swapAmount: args.amountIn.toString(),
      pool: WRSETH_BASE.toLowerCase(),
    },
  ];
  return {
    // Pseudo-venue label — same pattern as wrap.ts / send.ts. The
    // Venue union doesn't include "unwrap-wrseth"; the cast widens
    // at the construction site and downstream renderers treat venue
    // as a plain string.
    venue: "unwrap-wrseth" as unknown as Venue,
    amountIn: args.amountIn.toString(),
    amountOut: args.amountIn.toString(), // 1:1 by construction
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: WRSETH_BASE,
    hops,
    tokenHints: new Map(),
    raw: { wrseth: WRSETH_BASE, rseth: RSETH_BASE },
  };
}

export function buildUnwrapWrsethTx(args: {
  chain: ChainInfo;
  sender: string;
  amountIn: bigint;
}): NormalizedTx {
  if (args.chain.chainId !== BASE_CHAIN_ID) {
    throw new Error(
      `--action unwrapwrseth is only supported on Base (got chainId ${args.chain.chainId})`,
    );
  }
  const data = SEL_WITHDRAW + pad32Addr(RSETH_BASE) + pad32Big(args.amountIn);
  return {
    to: toChecksumAddress(WRSETH_BASE),
    from: args.sender,
    data,
    value: "0",
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    // No ERC20 approval is needed — the withdraw burns wrsETH from
    // msg.sender's own balance — but the orchestrator wants a spender
    // field on every NormalizedTx. Pointing at the wrsETH contract
    // mirrors what wrap.ts does for WETH withdraw, and the
    // orchestrator's allowance-check branch is skipped explicitly
    // for this action (alongside wrap/send).
    spender: toChecksumAddress(WRSETH_BASE),
    chainId: args.chain.chainId,
  };
}

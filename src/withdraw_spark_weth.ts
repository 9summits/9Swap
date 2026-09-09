// `--action withdrawsparkweth` short-circuit. Withdraws WETH from
// Spark Protocol's lending pool on mainnet — burns the user's spWETH
// (Spark's aToken-equivalent) and pays out WETH at 1:1 of position
// value. Lives outside the venue dispatcher for the same reason
// wrap.ts / send.ts / unwrap_wrseth.ts do: there's nothing to compare
// and nothing to route.
//
// CLI: swap <amount> weth -a withdrawsparkweth --chain eth
//
// Mechanism: Spark's Pool proxy at 0xC13e21B648A5Ee794902342038FF3aDAB66BE987
// (same ABI as Aave V3) exposes `withdraw(address asset, uint256 amount,
// address to)` at selector 0x69328dec. The pool then calls
// `aToken.burn(msg.sender, to, amount, …)` which is `onlyPool` — so the
// pool has built-in authority to burn the user's spWETH without an
// ERC20 allowance. The user receives WETH directly in their wallet.

import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./venues/index.ts";
import type { Token } from "./tokens.ts";
import { toChecksumAddress } from "./checksum.ts";

export const ETH_CHAIN_ID = 1;

// Spark Protocol addresses on Ethereum mainnet.
export const SPARK_POOL_MAINNET = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987";
export const SPWETH_MAINNET = "0x59cD1C87501baa753d0B5B5Ab5D8416A45cD71DB";
export const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// withdraw(address asset, uint256 amount, address to). Burns spWETH
// from msg.sender via pool authority and sends `amount` WETH to `to`.
const SEL_WITHDRAW = "0x69328dec";

function pad32Addr(a: string): string {
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function pad32Big(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

// Synth tokenIn is spWETH (the receipt token being burned), so
// `amount=max` reads the user's actual Spark position rather than
// their WETH wallet balance. The user's <tokenIn> CLI arg is ignored
// — same lenient stance as unwrap_wrseth (they might type "weth",
// "spweth", an address, anything).
export function makeSpwethToken(): Token {
  return {
    address: SPWETH_MAINNET,
    symbol: "spWETH",
    name: "Spark WETH",
    decimals: 18,
    chainId: ETH_CHAIN_ID,
    source: "hardcoded",
  };
}

export function makeWethMainnetToken(): Token {
  return {
    address: WETH_MAINNET,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    chainId: ETH_CHAIN_ID,
    source: "hardcoded",
  };
}

export function synthWithdrawSparkWethQuote(args: {
  amountIn: bigint;
}): NormalizedQuote {
  const hops: NormalizedHop[] = [
    {
      tokenIn: SPWETH_MAINNET.toLowerCase(),
      tokenOut: WETH_MAINNET.toLowerCase(),
      exchange: "spWETH → WETH (Spark withdraw)",
      swapAmount: args.amountIn.toString(),
      pool: SPARK_POOL_MAINNET.toLowerCase(),
    },
  ];
  return {
    // Pseudo-venue label — same pattern as wrap.ts / send.ts /
    // unwrap_wrseth.ts. Downstream renderers treat venue as a string.
    venue: "withdraw-spark-weth" as unknown as Venue,
    amountIn: args.amountIn.toString(),
    amountOut: args.amountIn.toString(), // 1:1 — spWETH represents WETH at par
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: SPARK_POOL_MAINNET,
    hops,
    tokenHints: new Map(),
    raw: {
      pool: SPARK_POOL_MAINNET,
      spweth: SPWETH_MAINNET,
      weth: WETH_MAINNET,
    },
  };
}

export function buildWithdrawSparkWethTx(args: {
  chain: ChainInfo;
  sender: string;
  amountIn: bigint;
}): NormalizedTx {
  if (args.chain.chainId !== ETH_CHAIN_ID) {
    throw new Error(
      `--action withdrawsparkweth is only supported on Ethereum mainnet (got chainId ${args.chain.chainId})`,
    );
  }
  const data =
    SEL_WITHDRAW +
    pad32Addr(WETH_MAINNET) +
    pad32Big(args.amountIn) +
    pad32Addr(args.sender);
  return {
    to: toChecksumAddress(SPARK_POOL_MAINNET),
    from: args.sender,
    data,
    value: "0",
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    // No ERC20 approval is needed — the pool burns spWETH via its
    // onlyPool authority on the aToken. The spender slot on
    // NormalizedTx is required by the type; pointing at the pool
    // mirrors what wrap.ts / unwrap_wrseth.ts do for similar
    // no-approval flows. The allowance-check branch in the
    // orchestrator is skipped explicitly for this action.
    spender: toChecksumAddress(SPARK_POOL_MAINNET),
    chainId: args.chain.chainId,
  };
}

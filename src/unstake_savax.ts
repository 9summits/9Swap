// `--action unstakesavax` short-circuit. Initiates an unlock of BENQI's
// sAVAX (liquid staked AVAX) on Avalanche by calling
// `requestUnlock(uint256 shareAmount)` on the sAVAX contract. The call
// queues the shares for redemption — the actual AVAX payout happens
// later, after BENQI's cooldown period elapses, via a separate
// redeem-style call. Lives outside the venue dispatcher for the same
// reason wrap.ts / withdraw_spark_weth.ts do: there's nothing to
// compare and no route to search.
//
// CLI: swap <amount> savax -a unstakesavax --chain avax
//
// Mechanism: sAVAX at 0x2b2C…A4bE exposes
// `requestUnlock(uint256 shareAmount)` at selector 0xc9d2ff9d. The
// contract debits the caller's sAVAX shares (msg.sender) and queues
// the redemption. No ERC20 approval is needed — the debit pulls from
// msg.sender's own balance.
//
// amountOut reflects the live sAVAX share price via
// `getPooledAvaxByShares(shareAmount)` on the sAVAX contract (selector
// 0x4a36d6c1). At redemption time the actual AVAX paid out is computed
// from the share price *then*, so this is still indicative — share
// price drifts up with staking yield — but it's vastly more accurate
// than a 1:1 placeholder (BENQI sAVAX trades at ~1.26 AVAX per share
// as of writing). If no RPC is configured, we fall back to 1:1 with a
// loud stderr warning so users don't broadcast unaware.

import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./venues/index.ts";
import type { Token } from "./tokens.ts";
import { toChecksumAddress } from "./checksum.ts";
import { NATIVE_SENTINEL } from "./tokens.ts";
import { redactRpc } from "./rpc.ts";

export const AVAX_CHAIN_ID = 43114;

// BENQI Liquid Staked AVAX (sAVAX) on Avalanche C-chain.
export const SAVAX_AVAX = "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE";

// requestUnlock(uint256 shareAmount). Debits msg.sender's sAVAX and
// queues the redemption.
const SEL_REQUEST_UNLOCK = "0xc9d2ff9d";

// getPooledAvaxByShares(uint256 shareAmount) returns the AVAX value of
// `shareAmount` sAVAX shares at the current share price.
const SEL_GET_POOLED_AVAX_BY_SHARES = "0x4a36d6c1";

function pad32Big(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

// Calls getPooledAvaxByShares on the sAVAX contract. Returns the AVAX
// amount (18 decimals) corresponding to `shareAmount` sAVAX. Throws on
// RPC error so the caller can fall back to 1:1 and warn. Exported so the
// claimsavax action (claim_savax.ts) can reuse the same share-price read.
export async function getPooledAvaxByShares(args: {
  rpc: string;
  shareAmount: bigint;
}): Promise<bigint> {
  const data = SEL_GET_POOLED_AVAX_BY_SHARES + pad32Big(args.shareAmount);
  const res = await fetch(args.rpc, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: SAVAX_AVAX, data }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    result?: string;
    error?: { message: string };
  };
  if (json.error) throw new Error(`rpc: ${json.error.message}`);
  if (!json.result || json.result === "0x") {
    throw new Error("getPooledAvaxByShares returned empty");
  }
  return BigInt(json.result);
}

// Synth tokenIn is sAVAX (the share token being unstaked), so
// `amount=max` reads the user's actual sAVAX balance. The user's
// <tokenIn> CLI arg is leniently ignored — same stance as
// unwrap_wrseth / withdraw_spark_weth.
export function makeSavaxToken(): Token {
  return {
    address: SAVAX_AVAX,
    symbol: "sAVAX",
    name: "BENQI Liquid Staked AVAX",
    decimals: 18,
    chainId: AVAX_CHAIN_ID,
    source: "hardcoded",
  };
}

export function makeAvaxNativeToken(): Token {
  return {
    address: NATIVE_SENTINEL,
    symbol: "AVAX",
    name: "Avalanche",
    decimals: 18,
    chainId: AVAX_CHAIN_ID,
    source: "hardcoded",
  };
}

export async function synthUnstakeSavaxQuote(args: {
  amountIn: bigint;
  rpc: string | null;
}): Promise<NormalizedQuote> {
  // Live share price → AVAX value of `amountIn` sAVAX shares. Fallback
  // to 1:1 with a loud warning when no RPC is configured or the call
  // errors — the alternative would be silently misleading the user
  // about how much AVAX they get out, which matters more than the
  // ~1 RPC round-trip we save.
  let amountOut = args.amountIn;
  if (args.rpc) {
    try {
      amountOut = await getPooledAvaxByShares({
        rpc: args.rpc,
        shareAmount: args.amountIn,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `! sAVAX share price unavailable: ${msg} — falling back to 1:1 (rpc=${redactRpc(args.rpc)})`,
      );
    }
  } else {
    console.error(
      `! no RPC configured — sAVAX → AVAX rate shown as 1:1 (actual rate is ~1.26x); set ALCHEMY_API_KEY or AVAX_RPC_URL for the real share price`,
    );
  }
  const hops: NormalizedHop[] = [
    {
      tokenIn: SAVAX_AVAX.toLowerCase(),
      tokenOut: NATIVE_SENTINEL,
      exchange: "sAVAX → AVAX (BENQI requestUnlock)",
      swapAmount: args.amountIn.toString(),
      pool: SAVAX_AVAX.toLowerCase(),
    },
  ];
  return {
    // Pseudo-venue label — same pattern as wrap.ts / send.ts /
    // withdraw_spark_weth.ts. Downstream renderers treat venue as a
    // string.
    venue: "unstake-savax" as unknown as Venue,
    amountIn: args.amountIn.toString(),
    amountOut: amountOut.toString(),
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: SAVAX_AVAX,
    hops,
    tokenHints: new Map(),
    raw: { savax: SAVAX_AVAX, shareToAvaxRate: amountOut.toString() },
  };
}

export function buildUnstakeSavaxTx(args: {
  chain: ChainInfo;
  sender: string;
  amountIn: bigint;
}): NormalizedTx {
  if (args.chain.chainId !== AVAX_CHAIN_ID) {
    throw new Error(
      `--action unstakesavax is only supported on Avalanche (got chainId ${args.chain.chainId})`,
    );
  }
  const data = SEL_REQUEST_UNLOCK + pad32Big(args.amountIn);
  return {
    to: toChecksumAddress(SAVAX_AVAX),
    from: args.sender,
    data,
    value: "0",
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    // No ERC20 approval is needed — requestUnlock debits sAVAX from
    // msg.sender's own balance. The spender slot on NormalizedTx is
    // required by the type; pointing at the sAVAX contract mirrors
    // wrap.ts / unwrap_wrseth.ts / withdraw_spark_weth.ts for similar
    // no-approval flows. The allowance-check branch in the orchestrator
    // is skipped explicitly for this action.
    spender: toChecksumAddress(SAVAX_AVAX),
    chainId: args.chain.chainId,
  };
}

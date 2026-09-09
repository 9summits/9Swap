// `--action send` short-circuit. Same shape as wrap.ts: skip the venue
// loop and synthesize a (NormalizedQuote, NormalizedTx) pair that the
// existing rendering / -d / --browser pipeline consumes.
//
// CLI:  swap <amount> <token> -a send --to <addr> --from <addr>
//
// For ERC20: tx = standard `transfer(to, amount)` on the token contract.
// For native: tx = direct value transfer (to=recipient, value=amount,
// data="0x"). No allowance check in either case — `transfer` operates
// on msg.sender's own balance, native send carries the value via
// msg.value.

import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./venues/index.ts";
import type { Token } from "./tokens.ts";
import { NATIVE_SENTINEL } from "./tokens.ts";
import { toChecksumAddress } from "./checksum.ts";

const SEL_TRANSFER = "0xa9059cbb"; // transfer(address,uint256)

function pad32Big(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function pad32Addr(a: string): string {
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function synthSendQuote(args: {
  token: Token;
  amountIn: bigint;
  recipient: string;
}): NormalizedQuote {
  const hops: NormalizedHop[] = [
    {
      tokenIn: args.token.address.toLowerCase(),
      tokenOut: args.token.address.toLowerCase(),
      exchange: `transfer to ${args.recipient}`,
      swapAmount: args.amountIn.toString(),
    },
  ];
  return {
    // Pseudo-venue label. Same idea as wrap.ts — never reaches the
    // dispatcher; cast widens Venue at the construction site.
    venue: "send" as unknown as Venue,
    amountIn: args.amountIn.toString(),
    amountOut: args.amountIn.toString(), // same token, no swap
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: null,
    hops,
    tokenHints: new Map(),
    raw: { recipient: args.recipient },
  };
}

export function buildSendTx(args: {
  chain: ChainInfo;
  sender: string;
  recipient: string;
  token: Token;
  amount: bigint;
}): NormalizedTx {
  const isNative = args.token.address.toLowerCase() === NATIVE_SENTINEL;
  const recipient = toChecksumAddress(args.recipient);
  if (isNative) {
    return {
      to: recipient,
      from: args.sender,
      data: "0x",
      value: `0x${args.amount.toString(16)}`,
      gas: null,
      gasPrice: null,
      maxPriorityFeePerGas: null,
      // No "spender" semantics for a native send — the recipient just
      // receives msg.value. We surface the recipient itself so the
      // rendered tx block has a non-empty spender field; nothing in the
      // approval-check path runs for action=send anyway.
      spender: recipient,
      chainId: args.chain.chainId,
    };
  }
  const data = SEL_TRANSFER + pad32Addr(recipient) + pad32Big(args.amount);
  return {
    to: toChecksumAddress(args.token.address),
    from: args.sender,
    data,
    value: "0",
    spender: toChecksumAddress(args.token.address),
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    chainId: args.chain.chainId,
  };
}

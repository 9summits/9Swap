import { keccak_256 } from "@noble/hashes/sha3.js";
import { NATIVE_SENTINEL } from "./tokens.ts";

// Multicall3 — deterministically deployed at this address on every chain
// in src/chains.ts. Used to read native balance
// inside an eth_simulateV1 batch (no equivalent of `eth_getBalance` mid-call).
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Sentinel value written to a candidate balances-slot during the probe; if
// balanceOf(holder) returns this exact 32-byte value with the override
// active, we know we found the right slot.
const PROBE_SENTINEL =
  "0x1337133713371337133713371337133713371337133713371337133713371337";

// Bound on slot probing. Vanilla OpenZeppelin layouts put `_balances` at
// slot 0; well-known forks (USDC, WETH9) at 9, 3 etc; OpenZeppelin
// **upgradeable** ERC20s push it deep (50-slot Context gap + ERC20
// fields + 45-slot ERC20 gap → typically slot ~50–101, e.g. KNC at 101).
// 128 covers every layout we've encountered while keeping the probe to
// 4 batched RPC reads' worth of calls. Bump if a real-world token blows
// through it.
const SLOT_PROBE_LIMIT = 128n;

function pad32Hex(input: string): string {
  return input.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function hexUint(n: bigint): string {
  return "0x" + (n === 0n ? "0" : n.toString(16));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Storage slot for `mapping(address => ...) m;` at slot N is
// keccak256(abi.encode(holder, N)) — 32-byte address, 32-byte slot.
function mappingSlotKey(holder: string, mappingPos: bigint): string {
  const concat = pad32Hex(holder) + pad32Hex(mappingPos.toString(16));
  const bytes = new Uint8Array(64);
  for (let i = 0; i < concat.length; i += 2) {
    bytes[i / 2] = parseInt(concat.substring(i, i + 2), 16);
  }
  return bytesToHex(keccak_256(bytes));
}

// ERC20 selectors.
function encodeBalanceOf(holder: string): string {
  return "0x70a08231" + pad32Hex(holder);
}
function encodeApprove(spender: string, amount: bigint): string {
  return (
    "0x095ea7b3" +
    pad32Hex(spender) +
    amount.toString(16).padStart(64, "0")
  );
}
// Multicall3.getEthBalance(address) — selector 0x4d2301cc.
function encodeMulticall3GetEthBalance(holder: string): string {
  return "0x4d2301cc" + pad32Hex(holder);
}

type SimulateV1Call = {
  to: string;
  data?: string;
  from?: string;
  value?: string;
  gas?: string;
};

type SimulateV1Log = {
  address: string;
  topics: string[];
  data: string;
};

type SimulateV1CallResult = {
  status: string;
  returnData?: string;
  gasUsed?: string;
  error?: { message: string; code: number; data?: string };
  // Populated by Alchemy / EIP-7522-compliant nodes inside an
  // eth_simulateV1 call result. Not all nodes return it — when absent,
  // log-based features (--debug referral transfer detection) silently
  // degrade to "no transfers found".
  logs?: SimulateV1Log[];
};

// Keccak-256 of "Transfer(address,address,uint256)" — the universal
// ERC20 / ERC721 transfer event signature.
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type SimulateV1Block = { calls: SimulateV1CallResult[] };
type SimulateV1Response = SimulateV1Block[];

async function rpcCall<T>(
  rpc: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (json.error) throw new Error(`rpc: ${json.error.message}`);
  if (json.result === undefined) throw new Error("rpc: no result");
  return json.result;
}

// Find the storage slot for the ERC20 balances mapping by writing a unique
// sentinel to each candidate slot via state override and seeing which slot
// makes balanceOf(holder) return the sentinel. Pure read — no real chain
// state is touched. Up to SLOT_PROBE_LIMIT calls in parallel.
export async function findBalanceSlot(
  rpc: string,
  token: string,
  holder: string,
): Promise<bigint | null> {
  const balanceOfData = encodeBalanceOf(holder);
  const probes: Promise<bigint | null>[] = [];
  for (let slot = 0n; slot < SLOT_PROBE_LIMIT; slot++) {
    const slotKey = mappingSlotKey(holder, slot);
    const override = {
      [token.toLowerCase()]: { stateDiff: { [slotKey]: PROBE_SENTINEL } },
    };
    probes.push(
      rpcCall<string>(rpc, "eth_call", [
        { to: token, data: balanceOfData },
        "latest",
        override,
      ])
        .then((result) =>
          result.toLowerCase() === PROBE_SENTINEL.toLowerCase() ? slot : null,
        )
        .catch(() => null),
    );
  }
  const results = await Promise.all(probes);
  return results.find((r): r is bigint => r !== null) ?? null;
}

export type WatchedTransfer = {
  /** ERC20 contract that emitted the Transfer event. Lower-cased. */
  token: string;
  /** Sender address from topics[1]. Lower-cased. */
  from: string;
  /** Recipient address (matched against the watch list). Lower-cased. */
  to: string;
  /** Caller-supplied label for the matched watch (e.g. "REFERRAL", "vault"). */
  label: string;
  /** Raw amount as uint256. */
  amount: bigint;
};

export type WatchSpec = {
  address: string;
  /** Free-form label surfaced verbatim by the renderer. */
  label: string;
};

export type SimulateResult = {
  approveStatus: "ok" | "reverted" | "skipped";
  approveGasUsed: bigint | null;
  swapStatus: "ok" | "reverted";
  swapGasUsed: bigint | null;
  swapRevertReason: string | null;
  tokenOutReceived: bigint;
  /**
   * Transfers to the address passed as `watchAddress`. Populated only
   * when `simulateSwap` was called with `watchAddress` (i.e. the user
   * passed `--debug` and `REFERRAL_ADDRESS` is set). Empty array means
   * the simulation ran but no transfers landed at that address; null
   * means no watch was requested. Non-null but empty: see "RPC didn't
   * return logs" caveat in simulate's body.
   */
  watchedTransfers: WatchedTransfer[] | null;
};

export type SimulateError =
  | { kind: "balance-slot-not-found"; token: string }
  | { kind: "rpc"; message: string };

export async function simulateSwap(opts: {
  rpc: string;
  sender: string;
  tokenIn: string;
  tokenInAmount: bigint;
  tokenOut: string;
  spender: string;
  swapTx: { to: string; data: string; value: string };
  /**
   * When non-empty, the simulation parses ERC20 Transfer logs emitted
   * by the swap call and surfaces every `Transfer(*, addr, *)` whose
   * recipient matches one of the watched addresses. The matching
   * `WatchSpec.label` is propagated to `WatchedTransfer.label` so the
   * renderer can group/annotate (e.g. "REFERRAL" vs "velora vault").
   */
  watches?: WatchSpec[];
}): Promise<{ ok: SimulateResult } | { err: SimulateError }> {
  const {
    rpc,
    sender,
    tokenIn,
    tokenInAmount,
    tokenOut,
    spender,
    swapTx,
    watches,
  } = opts;
  const watchList = watches ?? [];

  const isNativeIn = tokenIn.toLowerCase() === NATIVE_SENTINEL;
  const isNativeOut = tokenOut.toLowerCase() === NATIVE_SENTINEL;

  const stateOverrides: Record<string, unknown> = {};

  // Sender always needs a chunky native balance for gas. For native input
  // we also need amountIn worth of ETH on top.
  const gasBudget = 100n * 10n ** 18n;
  const senderNativeBalance = isNativeIn ? gasBudget + tokenInAmount : gasBudget;
  stateOverrides[sender.toLowerCase()] = {
    balance: hexUint(senderNativeBalance),
  };

  if (!isNativeIn) {
    const slot = await findBalanceSlot(rpc, tokenIn, sender);
    if (slot === null) {
      return { err: { kind: "balance-slot-not-found", token: tokenIn } };
    }
    const slotKey = mappingSlotKey(sender, slot);
    const slotValue = "0x" + tokenInAmount.toString(16).padStart(64, "0");
    stateOverrides[tokenIn.toLowerCase()] = {
      stateDiff: { [slotKey]: slotValue },
    };
  }

  // Native balance reads piggyback Multicall3 — no equivalent of
  // eth_getBalance inside an eth_simulateV1 batch, and we want pre/post
  // observations from inside the same simulated state.
  const balanceCallTarget = isNativeOut ? MULTICALL3 : tokenOut;
  const balanceCallData = isNativeOut
    ? encodeMulticall3GetEthBalance(sender)
    : encodeBalanceOf(sender);

  const calls: SimulateV1Call[] = [];
  // [0] pre-balance read
  calls.push({ to: balanceCallTarget, data: balanceCallData });
  // [1] approve (only for ERC20 input)
  if (!isNativeIn) {
    calls.push({
      to: tokenIn,
      data: encodeApprove(spender, tokenInAmount),
      from: sender,
    });
  }
  // [N-2] swap
  calls.push({
    to: swapTx.to,
    data: swapTx.data,
    from: sender,
    value: hexUint(BigInt(swapTx.value || "0")),
  });
  // [N-1] post-balance read
  calls.push({ to: balanceCallTarget, data: balanceCallData });

  let response: SimulateV1Response;
  try {
    response = await rpcCall<SimulateV1Response>(rpc, "eth_simulateV1", [
      {
        blockStateCalls: [{ stateOverrides, calls }],
        validation: false,
        // Alchemy-specific: synthesizes Transfer-style logs for native
        // ETH movement so the watch can catch ETH-denominated payouts
        // too. Ignored by RPCs that don't recognize the flag — they
        // still return the regular ERC20 Transfer logs we need.
        traceTransfers: watchList.length > 0 || undefined,
      },
      "latest",
    ]);
  } catch (err) {
    return {
      err: {
        kind: "rpc",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const block = response[0];
  if (!block) {
    return {
      err: { kind: "rpc", message: "eth_simulateV1: empty blockStateCalls" },
    };
  }
  const r = block.calls;

  const approveIndex = isNativeIn ? -1 : 1;
  const swapIndex = isNativeIn ? 1 : 2;
  const preIndex = 0;
  const postIndex = r.length - 1;

  const preBalance = BigInt(r[preIndex]?.returnData ?? "0x0");
  const postBalance = BigInt(r[postIndex]?.returnData ?? "0x0");

  let approveStatus: "ok" | "reverted" | "skipped" = "skipped";
  let approveGasUsed: bigint | null = null;
  if (approveIndex >= 0) {
    const a = r[approveIndex];
    approveStatus = a?.status === "0x1" ? "ok" : "reverted";
    approveGasUsed = a?.gasUsed ? BigInt(a.gasUsed) : null;
  }

  const swap = r[swapIndex];
  const swapStatus: "ok" | "reverted" =
    swap?.status === "0x1" ? "ok" : "reverted";
  const swapGasUsed = swap?.gasUsed ? BigInt(swap.gasUsed) : null;
  const swapRevertReason =
    swapStatus === "reverted"
      ? swap?.error?.message ?? parseRevertReason(swap?.returnData)
      : null;

  // Only meaningful when swap succeeded; on revert the post-balance equals
  // pre-balance (no state change persists past the failing call).
  const tokenOutReceived =
    swapStatus === "ok" ? postBalance - preBalance : 0n;

  // Watched-transfer detection. Pulls Transfer events from every call's
  // logs (not just the swap call — referral fees are sometimes paid
  // during the approve, e.g. on hooked tokens). Only runs when the
  // caller asked for one or more watches via `watches`.
  let watchedTransfers: WatchedTransfer[] | null = null;
  if (watchList.length > 0) {
    watchedTransfers = [];
    if (swapStatus === "ok") {
      const labelByAddr = new Map(
        watchList.map((w) => [w.address.toLowerCase(), w.label]),
      );
      for (const call of r) {
        for (const log of call.logs ?? []) {
          if (log.topics.length < 3) continue;
          if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
          const toTopic = log.topics[2]?.toLowerCase();
          if (!toTopic) continue;
          const toAddr = "0x" + toTopic.slice(-40);
          const label = labelByAddr.get(toAddr);
          if (label === undefined) continue;
          const fromTopic = log.topics[1]?.toLowerCase() ?? "";
          watchedTransfers.push({
            token: log.address.toLowerCase(),
            from: "0x" + fromTopic.slice(-40),
            to: toAddr,
            label,
            amount: BigInt(log.data || "0x0"),
          });
        }
      }
    }
  }

  return {
    ok: {
      approveStatus,
      approveGasUsed,
      swapStatus,
      swapGasUsed,
      swapRevertReason,
      tokenOutReceived,
      watchedTransfers,
    },
  };
}

// Best-effort decode of standard Solidity revert payloads.
function parseRevertReason(returnData: string | undefined): string | null {
  if (!returnData || returnData === "0x") return null;
  // Error(string) → 0x08c379a0
  if (returnData.startsWith("0x08c379a0") && returnData.length >= 138) {
    try {
      const lenHex = returnData.slice(2 + 8 + 64, 2 + 8 + 128);
      const len = parseInt(lenHex, 16);
      const dataHex = returnData.slice(2 + 8 + 128, 2 + 8 + 128 + len * 2);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < dataHex.length; i += 2) {
        bytes[i / 2] = parseInt(dataHex.substring(i, i + 2), 16);
      }
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }
  // Panic(uint256) → 0x4e487b71
  if (returnData.startsWith("0x4e487b71")) {
    return `Panic(0x${returnData.slice(2 + 8 + 62, 2 + 8 + 64)})`;
  }
  // Known custom-error selectors. Hand-curated for ones that come up
  // often in this CLI's flows (1inch, Uniswap, Permit2). Add more as
  // they're encountered — the fallback is the raw selector hex.
  const KNOWN_SELECTORS: Record<string, string> = {
    "0xf4059071": "SafeTransferFromFailed",
    "0x064a4ec6": "ReturnAmountIsNotEnough",
    "0x4ca88867": "AccessDenied",
    "0xa2cabb7e": "InvalidMsgValue",
  };
  // Custom error: report the 4-byte selector so the user can decode it.
  if (returnData.length >= 10) {
    const sel = returnData.slice(0, 10).toLowerCase();
    return KNOWN_SELECTORS[sel] ?? `custom error ${sel}`;
  }
  return null;
}

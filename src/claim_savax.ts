// `--action claimsavax` short-circuit. Claims matured AVAX from BENQI's
// sAVAX (liquid staked AVAX) unlock requests on Avalanche by calling
// `redeem()` (no args) on the sAVAX contract.
//
// Lifecycle: `-a unstakesavax` calls requestUnlock(shareAmount), which
// queues an unlock request. Each request then goes through:
//   1. cooldown   (cooldownPeriod, ~15 days) — not yet redeemable
//   2. redeem window (redeemPeriod, ~2 days) — redeem() pays out AVAX
//   3. overdue    (past the window) — redeemOverdueShares() returns the
//                  *sAVAX shares*, NOT AVAX (we don't touch this path)
//
// We always call the no-arg `redeem()` (selector 0xbe040fb0): it iterates
// the caller's unlock requests and redeems every one currently inside its
// redemption window, skipping the rest — it never reverts on requests
// still in cooldown. The single-index `redeem(uint256)` exists but isn't
// used (claim-all-eligible is the chosen UX). Pays out native AVAX; there
// is no atomic WAVAX path — to get WAVAX, wrap afterward with
// `swap <amt> AVAX WAVAX --chain avax`.
//
// CLI: swap x savax -a claimsavax --chain avax --from <addr>
//
// The <amount> positional is an ignored placeholder — what gets claimed is
// whatever is matured on-chain, not a user-supplied amount. Same lenient
// stance as unwrap_wrseth / withdraw_spark_weth / unstake_savax around
// <tokenIn>. amountOut is the live AVAX value of the matured shares via
// getPooledAvaxByShares; the per-request status summary (claimable /
// pending with ETA / overdue) is printed to stderr by index.ts.
//
// Mechanism: sAVAX at 0x2b2C…A4bE exposes `redeem()` at selector
// 0xbe040fb0. The call pays out msg.sender's matured AVAX. No ERC20
// approval is needed — it operates on the caller's own queued requests.

import type { ChainInfo } from "./chains.ts";
import type {
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  Venue,
} from "./venues/index.ts";
import { toChecksumAddress } from "./checksum.ts";
import { NATIVE_SENTINEL } from "./tokens.ts";
import { fromBaseUnits } from "./amount.ts";
import {
  AVAX_CHAIN_ID,
  SAVAX_AVAX,
  getPooledAvaxByShares,
} from "./unstake_savax.ts";

// redeem() — no args. Redeems every matured unlock request of msg.sender,
// skipping those still in cooldown. Pays out native AVAX.
const SEL_REDEEM = "0xbe040fb0";

// getUnlockRequestCount(address user) returns uint256.
const SEL_UNLOCK_REQUEST_COUNT = "0xc423f9a8";

// userUnlockRequests(address, uint256) returns (uint256 startedAt,
// uint256 shareAmount) — the i-th queued request of the user.
const SEL_USER_UNLOCK_REQUESTS = "0xfd012e34";

// cooldownPeriod() / redeemPeriod() return uint256 seconds.
const SEL_COOLDOWN_PERIOD = "0x04646a49";
const SEL_REDEEM_PERIOD = "0x40a233a6";

function pad32Big(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function pad32Addr(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// Minimal eth_call wrapper. Returns the raw result hex. Throws on RPC or
// EVM error so the caller can warn and degrade rather than silently lie.
async function ethCall(args: {
  rpc: string;
  to: string;
  data: string;
}): Promise<string> {
  const res = await fetch(args.rpc, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: args.to, data: args.data }, "latest"],
    }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    result?: string;
    error?: { message: string };
  };
  if (json.error) throw new Error(`rpc: ${json.error.message}`);
  if (!json.result || json.result === "0x") {
    throw new Error("eth_call returned empty");
  }
  return json.result;
}

// Reads the latest block's timestamp — the chain's notion of "now", which
// is what redeem() compares each request's deadlines against. Using chain
// time (not wall-clock) keeps the claimable/pending/overdue split exact at
// the window boundaries.
async function getBlockTimestamp(rpc: string): Promise<bigint> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);
  const json = (await res.json()) as {
    result?: { timestamp?: string };
    error?: { message: string };
  };
  if (json.error) throw new Error(`rpc: ${json.error.message}`);
  if (!json.result?.timestamp) throw new Error("block has no timestamp");
  return BigInt(json.result.timestamp);
}

export type ClaimRequestStatus = "pending" | "claimable" | "overdue";

export interface ClaimRequestInfo {
  index: number;
  startedAt: bigint;
  shareAmount: bigint;
  status: ClaimRequestStatus;
  // Seconds remaining: until claimable (pending) / until the window closes
  // (claimable) / since it went overdue (overdue).
  etaSec: bigint;
}

export interface ClaimDiscovery {
  requests: ClaimRequestInfo[];
  // Sum of shareAmount over requests with status === "claimable".
  claimableShares: bigint;
  // AVAX value of claimableShares at the current share price.
  claimableAvax: bigint;
  cooldownSec: bigint;
  redeemPeriodSec: bigint;
}

// Reads the owner's unlock requests and classifies each one. Requires both
// an RPC and an owner address — index.ts only calls this when --from is set
// and an RPC is configured. Throws on RPC error so the caller can warn.
export async function discoverClaimableSavax(args: {
  rpc: string;
  owner: string;
}): Promise<ClaimDiscovery> {
  const { rpc, owner } = args;

  const count = BigInt(
    await ethCall({
      rpc,
      to: SAVAX_AVAX,
      data: SEL_UNLOCK_REQUEST_COUNT + pad32Addr(owner),
    }),
  );

  // Periods + chain time in parallel with the per-request reads.
  const [cooldownSec, redeemPeriodSec, now, ...reqHexes] = await Promise.all([
    ethCall({ rpc, to: SAVAX_AVAX, data: SEL_COOLDOWN_PERIOD }).then((h) =>
      BigInt(h),
    ),
    ethCall({ rpc, to: SAVAX_AVAX, data: SEL_REDEEM_PERIOD }).then((h) =>
      BigInt(h),
    ),
    getBlockTimestamp(rpc),
    ...Array.from({ length: Number(count) }, (_, i) =>
      ethCall({
        rpc,
        to: SAVAX_AVAX,
        data: SEL_USER_UNLOCK_REQUESTS + pad32Addr(owner) + pad32Big(BigInt(i)),
      }),
    ),
  ]);

  const requests: ClaimRequestInfo[] = reqHexes.map((hex, i) => {
    // (uint256 startedAt, uint256 shareAmount) — two packed 32-byte words.
    const body = hex.replace(/^0x/, "");
    const startedAt = BigInt("0x" + body.slice(0, 64));
    const shareAmount = BigInt("0x" + body.slice(64, 128));
    const claimableAt = startedAt + cooldownSec;
    const overdueAt = claimableAt + redeemPeriodSec;
    let status: ClaimRequestStatus;
    let etaSec: bigint;
    if (now < claimableAt) {
      status = "pending";
      etaSec = claimableAt - now;
    } else if (now < overdueAt) {
      status = "claimable";
      etaSec = overdueAt - now;
    } else {
      status = "overdue";
      etaSec = now - overdueAt;
    }
    return { index: i, startedAt, shareAmount, status, etaSec };
  });

  const claimableShares = requests
    .filter((r) => r.status === "claimable")
    .reduce((acc, r) => acc + r.shareAmount, 0n);

  const claimableAvax =
    claimableShares > 0n
      ? await getPooledAvaxByShares({ rpc, shareAmount: claimableShares })
      : 0n;

  return {
    requests,
    claimableShares,
    claimableAvax,
    cooldownSec,
    redeemPeriodSec,
  };
}

// Human "Xd Yh" / "Yh Zm" / "Zm" duration, for the stderr status summary.
function fmtDuration(sec: bigint): string {
  const s = Number(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Builds the stderr status summary lines. Caller gates on output mode
// (skipped under --json / --simple).
export function formatClaimSummary(
  discovery: ClaimDiscovery,
  owner: string,
): string[] {
  const lines: string[] = [];
  const short = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
  lines.push(
    `  sAVAX unlock requests for ${short} ` +
      `(cooldown ${fmtDuration(discovery.cooldownSec)}, ` +
      `redeem window ${fmtDuration(discovery.redeemPeriodSec)}):`,
  );
  if (discovery.requests.length === 0) {
    lines.push(`    (none — run \`-a unstakesavax\` first to queue an unlock)`);
    return lines;
  }
  for (const r of discovery.requests) {
    const shares = `${fromBaseUnits(r.shareAmount, 18, 4)} sAVAX`;
    if (r.status === "claimable") {
      lines.push(
        `    #${r.index}  claimable  ${shares}   window closes in ${fmtDuration(r.etaSec)}`,
      );
    } else if (r.status === "pending") {
      lines.push(
        `    #${r.index}  pending    ${shares}   claimable in ${fmtDuration(r.etaSec)}`,
      );
    } else {
      lines.push(
        `    #${r.index}  overdue    ${shares}   use redeemOverdueShares (returns sAVAX)`,
      );
    }
  }
  const claimableCount = discovery.requests.filter(
    (r) => r.status === "claimable",
  ).length;
  if (claimableCount > 0) {
    lines.push(
      `  redeem() will claim ${claimableCount} request${claimableCount === 1 ? "" : "s"} ` +
        `→ ≈ ${fromBaseUnits(discovery.claimableAvax, 18, 6)} AVAX`,
    );
  } else {
    lines.push(`  redeem() will claim 0 requests (nothing in its redeem window)`);
  }
  return lines;
}

export function synthClaimSavaxQuote(args: {
  amountIn: bigint;
  amountOut: bigint;
  discovery: ClaimDiscovery | null;
}): NormalizedQuote {
  const hops: NormalizedHop[] = [
    {
      tokenIn: SAVAX_AVAX.toLowerCase(),
      tokenOut: NATIVE_SENTINEL,
      exchange: "sAVAX → AVAX (BENQI redeem)",
      swapAmount: args.amountIn.toString(),
      pool: SAVAX_AVAX.toLowerCase(),
    },
  ];
  return {
    // Pseudo-venue label — same pattern as wrap.ts / send.ts /
    // unstake_savax.ts. Downstream renderers treat venue as a string.
    venue: "claim-savax" as unknown as Venue,
    amountIn: args.amountIn.toString(),
    amountOut: args.amountOut.toString(),
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: SAVAX_AVAX,
    hops,
    tokenHints: new Map(),
    raw: {
      savax: SAVAX_AVAX,
      claimableShares: args.amountIn.toString(),
      claimableAvax: args.amountOut.toString(),
      requests:
        args.discovery?.requests.map((r) => ({
          index: r.index,
          startedAt: r.startedAt.toString(),
          shareAmount: r.shareAmount.toString(),
          status: r.status,
          etaSec: r.etaSec.toString(),
        })) ?? null,
    },
  };
}

export function buildClaimSavaxTx(args: {
  chain: ChainInfo;
  sender: string;
}): NormalizedTx {
  if (args.chain.chainId !== AVAX_CHAIN_ID) {
    throw new Error(
      `--action claimsavax is only supported on Avalanche (got chainId ${args.chain.chainId})`,
    );
  }
  return {
    to: toChecksumAddress(SAVAX_AVAX),
    from: args.sender,
    // redeem() — no calldata args.
    data: SEL_REDEEM,
    value: "0",
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    // No ERC20 approval is needed — redeem() pays out from msg.sender's own
    // queued unlock requests. The spender slot is required by the type;
    // pointing at the sAVAX contract mirrors unstake_savax.ts. The
    // allowance-check branch in the orchestrator is skipped for this action.
    spender: toChecksumAddress(SAVAX_AVAX),
    chainId: args.chain.chainId,
  };
}

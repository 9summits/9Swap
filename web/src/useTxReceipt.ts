import { useEffect, useState } from "react";
import {
  createPublicClient,
  http,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { useWaitForTransactionReceipt } from "wagmi";
import { CORS_OPEN_RPC } from "./publicRpc";
import { knownChains } from "./wagmi";

// How often the independent backup poll hits eth_getTransactionReceipt /
// eth_getTransactionByHash. Separate from wagmi's block-watcher cadence.
const BACKUP_POLL_MS = 2_000;

// Transport / infra failures on the primary path — keep waiting on the
// backup poll instead of flipping the UI to a hard error.
const NETWORKISH =
  /fetch|CORS|network|timeout|ECONN|429|502|503|HTTP request failed|Failed to fetch/i;

/**
 * Receipt waiter that survives protected / private-mempool RPCs.
 *
 * Primary path: wagmi's `useWaitForTransactionReceipt` (block watcher on the
 * config transport). That path breaks when:
 *   - the wallet routes eth_* reads through a MEV-protected RPC that never
 *     surfaces privately-submitted txs until inclusion (or never at all), or
 *   - the configured public transport is CORS-blocked in the browser
 *     (viem mainnet default eth.merkle.io) — hang forever because wagmi sets
 *     timeout: 0.
 *
 * Backup path (this hook): independent 2s poll against a CORS-open public
 * RPC (PublicNode). Checks eth_getTransactionByHash for a non-null
 * blockNumber (inclusion) then eth_getTransactionReceipt. First path to
 * resolve wins. Reverted receipts surface as errors, matching wagmi.
 */
export function useTxReceipt(args: {
  hash: Hash | undefined;
  chainId: number;
}): {
  data: TransactionReceipt | undefined;
  isSuccess: boolean;
  isLoading: boolean;
  error: Error | null;
} {
  const wagmi = useWaitForTransactionReceipt({
    hash: args.hash,
    chainId: args.chainId,
  });

  const [backup, setBackup] = useState<{
    hash: Hash | undefined;
    receipt: TransactionReceipt | null;
    error: Error | null;
  }>({ hash: undefined, receipt: null, error: null });

  // Drop stale backup results when the watched hash changes.
  const backupForHash = backup.hash === args.hash ? backup : null;
  const backupReceipt = backupForHash?.receipt ?? null;
  const backupError = backupForHash?.error ?? null;

  useEffect(() => {
    const hash = args.hash;
    if (!hash) return;
    // Primary path already confirmed success — no need to keep polling.
    if (wagmi.isSuccess) return;
    // Backup already settled for this hash.
    if (backup.hash === hash && (backup.receipt || backup.error)) return;

    const chain = knownChains.find((c) => c.id === args.chainId);
    const url =
      CORS_OPEN_RPC[args.chainId] ?? chain?.rpcUrls.default.http[0] ?? null;
    if (!chain || !url) return;

    const client = createPublicClient({
      chain,
      transport: http(url, { retryCount: 0 }),
    });

    let cancelled = false;

    const tick = async () => {
      try {
        // Inclusion probe: eth_getTransactionByHash. A non-null blockNumber
        // means the tx is in a block even if the receipt RPC is lagging.
        // Pending / unknown → null blockNumber or throw — keep polling.
        try {
          await client.getTransaction({ hash });
        } catch {
          // TransactionNotFoundError / network blip — not mined yet, or
          // this public node hasn't indexed a privately-submitted hash.
        }

        try {
          const receipt = await client.getTransactionReceipt({ hash });
          if (cancelled) return;
          if (receipt.status === "reverted") {
            setBackup({
              hash,
              receipt,
              error: new Error("Transaction reverted"),
            });
            return;
          }
          setBackup({ hash, receipt, error: null });
        } catch {
          // Receipt not found yet — next interval retries.
        }
      } catch (e) {
        // Unexpected transport failure — don't kill the poll; the next
        // tick (or the primary wagmi path) may still succeed.
        console.warn("useTxReceipt backup poll:", e);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), BACKUP_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    args.hash,
    args.chainId,
    wagmi.isSuccess,
    backup.hash,
    backup.receipt,
    backup.error,
  ]);

  // Merge: first path to resolve wins. While the backup poll is still live,
  // suppress primary-path transport errors so a flaky wagmi transport doesn't
  // flip the UI to "error" while we're still waiting for inclusion.
  const data = wagmi.data ?? backupReceipt ?? undefined;
  const isSuccess =
    wagmi.isSuccess ||
    (!!backupReceipt && backupReceipt.status === "success");

  let error: Error | null = null;
  if (!isSuccess) {
    if (backupError) {
      error = backupError;
    } else if (wagmi.isError && wagmi.error) {
      const msg = wagmi.error.message ?? "";
      if (!NETWORKISH.test(msg)) {
        // Revert reason (or other terminal error) from wagmi.
        error = wagmi.error as Error;
      }
    }
  }

  // Confirming = we have a hash and neither path has settled yet.
  const isLoading = Boolean(args.hash) && !isSuccess && !error;

  return { data, isSuccess, isLoading, error };
}

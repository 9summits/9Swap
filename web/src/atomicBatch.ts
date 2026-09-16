import { useEffect, useRef } from "react";
import { useAccount, useCapabilities } from "wagmi";

// Which execution shape the connected wallet gets for approve + swap.
//
// "atomic" is not only a UX nicety. `eth_sendTransaction` through a Safe
// returns a safeTxHash, not an on-chain tx hash, so the public-RPC receipt poll
// never resolves and the sequential path hangs forever. Any wallet that reports
// EIP-5792 atomic batching therefore goes through wallet_sendCalls, even when
// no approval is needed and the batch holds a single call.
export type Executor = "sequential" | "atomic";

export function useExecutor(chainId: number): {
  executor: Executor;
  resolved: boolean;
} {
  const { address } = useAccount();
  const { data, isSuccess, isError, error } = useCapabilities({
    account: address,
    chainId,
    query: { enabled: !!address, retry: false, staleTime: Infinity },
  });

  const loggedRef = useRef(false);
  useEffect(() => {
    if (!isError || loggedRef.current) return;
    loggedRef.current = true;
    console.info(
      `wallet_getCapabilities unavailable on chain ${chainId}; using sequential approve + swap`,
      error,
    );
  }, [isError, error, chainId]);

  // 'ready' means the wallet COULD batch after an EIP-7702 upgrade (MetaMask
  // EOAs): taking it would prompt an account upgrade the user never asked for,
  // so only 'supported' counts. atomicBatch is the pre-final 5792 spelling some
  // wallets still answer with.
  const atomic =
    data?.atomic?.status === "supported" || data?.atomicBatch?.supported === true;

  return {
    executor: atomic ? "atomic" : "sequential",
    resolved: !address || isSuccess || isError,
  };
}

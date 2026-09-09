import { useEffect, useRef, useState } from "react";
import {
  useAccount,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import type { Hex } from "viem";
import type {
  ApprovalInfo,
  ChainMeta,
  SwapPermitTx,
  TokenMeta,
} from "./payload";
import { assemblePermitTx, reportDone, type AssembledTx } from "./api";
import { ExecStatusView, type ExecPhase } from "./dapp/ExecStatus";
import type { SendTxRun } from "./SendTx";
import { useTxReceipt } from "./useTxReceipt";

// Path A flow for Uniswap V4 / split / mixed routes:
//   1. (optional) approve tokenIn to Permit2.
//   2. Sign Permit2 PermitSingle EIP-712 typed data.
//   3. POST signature → /assemble (local server hits Uniswap /v1/swap).
//   4. sendTransaction the returned calldata.
//   5. /done with hash.
type Step = "approve" | "sign" | "assemble" | "swap" | "done";

function fmt(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = n / base;
    const frac = n % base;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
    return `${whole}.${fracStr.replace(/0+$/, "") || "0"}`;
  } catch {
    return raw;
  }
}

export function SignPermitTx({
  sid,
  permitTx,
  chain,
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  slippageBps,
  approval,
  assembleContext,
  autoStart = false,
  compact = false,
  onPhase,
}: {
  sid: string;
  permitTx: SwapPermitTx;
  chain: ChainMeta;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string;
  amountOut: string;
  slippageBps: number;
  approval: ApprovalInfo | null;
  // Opaque context for stateless /assemble (Vercel). Absent in the legacy
  // --browser one-shot flow where the server holds state in memory.
  assembleContext?: unknown;
  // Interactive dApp: auto-fire (approve → sign → assemble → send) and compact.
  autoStart?: boolean;
  compact?: boolean;
  onPhase?: (run: SendTxRun) => void;
}) {
  const { address, chainId: connectedChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const needsApprove = !!approval && approval.needed && !!approval.approveTx;
  const approveTx = approval?.approveTx ?? null;

  const approveHook = useSendTransaction();
  // Dual-path receipt: wagmi + independent public-RPC poll (see useTxReceipt).
  const approveReceipt = useTxReceipt({
    hash: approveHook.data,
    chainId: chain.chainId,
  });

  const sigHook = useSignTypedData();
  const swapHook = useSendTransaction();
  const swapReceipt = useTxReceipt({
    hash: swapHook.data,
    chainId: chain.chainId,
  });

  const [step, setStep] = useState<Step>(needsApprove ? "approve" : "sign");
  const [assembleErr, setAssembleErr] = useState<string | null>(null);
  const [assembled, setAssembled] = useState<AssembledTx | null>(null);

  useEffect(() => {
    if (step === "approve" && approveReceipt.isSuccess) setStep("sign");
  }, [step, approveReceipt.isSuccess]);

  useEffect(() => {
    if (step === "swap" && swapReceipt.isSuccess && swapHook.data) {
      reportDone(sid, {
        kind: "tx",
        hash: swapHook.data,
        venue: permitTx.venue,
        chainId: chain.chainId,
      });
      setStep("done");
    }
  }, [
    step,
    swapReceipt.isSuccess,
    swapHook.data,
    sid,
    permitTx.venue,
    chain.chainId,
  ]);

  // Network-switch failure (rejected chain prompt, or the wallet threw). Its
  // own state so it feeds the same error channel as sign/assemble/send errors
  // — without it the panel sat on "opening your wallet…" forever, since the
  // step after ensureChain was never reached.
  const [chainErr, setChainErr] = useState<string | null>(null);

  const wrongChain =
    typeof connectedChainId === "number" && connectedChainId !== chain.chainId;

  // Returns false when the switch was rejected/failed — callers MUST abort.
  // The auto-start refs stay armed (no prompt loop); retry clears them.
  async function ensureChain(): Promise<boolean> {
    setChainErr(null);
    if (!wrongChain) return true;
    try {
      await switchChainAsync({ chainId: chain.chainId });
      return true;
    } catch (e) {
      console.warn(`SignPermitTx: switch to chain ${chain.chainId} failed`, e);
      const short = (e as { shortMessage?: string } | undefined)?.shortMessage;
      setChainErr(
        short
          ? `${short} Switch to ${chain.name} in your wallet and retry.`
          : `Network switch rejected — switch to ${chain.name} in your wallet and retry.`,
      );
      return false;
    }
  }

  async function clickApprove() {
    if (!approveTx) return;
    if (!(await ensureChain())) return;
    approveHook.sendTransaction({
      to: approveTx.to as Hex,
      data: approveTx.data as Hex,
      value: BigInt(approveTx.value || "0"),
      chainId: chain.chainId,
    });
  }

  async function clickSign() {
    if (!(await ensureChain())) return;
    setAssembleErr(null);
    const td = permitTx.typedData;
    // signTypedData rejects EIP712Domain inside `types`; the server
    // already strips it, but be defensive in case the payload isn't
    // pre-trimmed.
    const types = { ...td.types };
    delete (types as Record<string, unknown>).EIP712Domain;
    let sig: Hex;
    try {
      sig = await sigHook.signTypedDataAsync({
        domain: td.domain as Record<string, unknown>,
        types: types as Record<string, Array<{ name: string; type: string }>>,
        primaryType: td.primaryType,
        message: td.message,
      });
    } catch (e) {
      setAssembleErr((e as Error).message ?? "sign failed");
      return;
    }
    setStep("assemble");
    let tx: AssembledTx;
    try {
      tx = await assemblePermitTx(sid, sig, assembleContext);
    } catch (e) {
      setAssembleErr((e as Error).message ?? "assemble failed");
      setStep("sign");
      return;
    }
    setAssembled(tx);
    setStep("swap");
  }

  async function clickSwap() {
    if (!assembled) return;
    if (!(await ensureChain())) return;
    swapHook.sendTransaction({
      to: assembled.to as Hex,
      data: assembled.data as Hex,
      value: BigInt(assembled.value || "0"),
      gas: assembled.gas ? BigInt(assembled.gas) : undefined,
      chainId: chain.chainId,
    });
  }

  const explorerTxUrl = (h: string) => `${chain.explorer}/tx/${h}`;

  // ── autoStart: approve → sign → assemble → send, no extra clicks. Refs guard
  // each leg; clickSign internally advances sign → assemble → swap.
  const autoApproveFired = useRef(false);
  const autoSignFired = useRef(false);
  const autoSwapFired = useRef(false);
  useEffect(() => {
    if (!autoStart || !address) return;
    if (
      step === "approve" &&
      needsApprove &&
      !autoApproveFired.current &&
      !approveHook.isPending
    ) {
      autoApproveFired.current = true;
      void clickApprove();
    }
    if (step === "sign" && !autoSignFired.current && !sigHook.isPending) {
      autoSignFired.current = true;
      void clickSign();
    }
    if (
      step === "swap" &&
      assembled &&
      !autoSwapFired.current &&
      !swapHook.isPending
    ) {
      autoSwapFired.current = true;
      void clickSwap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, address, step, assembled, needsApprove]);

  const approving = needsApprove && step === "approve";
  const runError =
    chainErr ??
    assembleErr ??
    swapHook.error?.message ??
    approveHook.error?.message ??
    swapReceipt.error?.message ??
    approveReceipt.error?.message ??
    null;
  const runStage: SendTxRun["stage"] =
    step === "done" ? "done" : runError ? "error" : approving ? "approve" : "swap";
  const runPending = approving
    ? approveHook.isPending
    : sigHook.isPending || swapHook.isPending;
  const runConfirming = approving
    ? approveReceipt.isLoading
    : step === "assemble" || swapReceipt.isLoading;

  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  useEffect(() => {
    onPhaseRef.current?.({
      stage: runStage,
      pending: runPending,
      confirming: runConfirming,
      error: runError,
    });
  }, [runStage, runPending, runConfirming, runError]);

  // Interactive dApp: compact, auto-fired status (no duplicate step panels).
  // Receipt errors matter: useTxReceipt rejects when the mined receipt has
  // status "reverted", so swapHook/approveHook.error stay null after a
  // broadcast-then-reverted tx. Mirror SendTx's chain so the panel surfaces
  // the error + retry instead of "opening your wallet…".
  if (compact) {
    const phase: ExecPhase =
      step === "done" ? "done" : runError ? "error" : "working";
    const text =
      step === "approve"
        ? approveHook.isPending
          ? `confirm ${tokenIn.symbol} approval in your wallet…`
          : approveReceipt.isLoading
            ? `approving ${tokenIn.symbol}…`
            : `approve ${tokenIn.symbol} in your wallet…`
        : step === "sign"
          ? sigHook.isPending
            ? "sign the permit in your wallet…"
            : "opening your wallet…"
          : step === "assemble"
            ? "assembling the swap…"
            : swapHook.isPending
              ? "confirm in your wallet…"
              : swapReceipt.isLoading
                ? "waiting for confirmation…"
                : "opening your wallet…";
    const onRetry = () => {
      if (step === "approve") {
        autoApproveFired.current = false;
        void clickApprove();
      } else if (step === "swap" && assembled) {
        autoSwapFired.current = false;
        void clickSwap();
      } else {
        autoSignFired.current = false;
        void clickSign();
      }
    };
    // wrongChainName: suppressed while chainErr is set — that message already
    // spells out "switch to <chain> and retry", no need to stack both.
    return (
      <ExecStatusView
        phase={phase}
        text={text}
        doneText="Swap confirmed"
        error={runError}
        txHash={swapHook.data ?? approveHook.data ?? null}
        explorer={chain.explorer}
        onRetry={onRetry}
        wrongChainName={wrongChain && !chainErr ? chain.name : null}
      />
    );
  }

  return (
    <div>
      <div className="panel">
        <div className="row">
          <span className="k">you sell</span>
          <span className="v">
            <strong>
              {fmt(amountIn, tokenIn.decimals)} {tokenIn.symbol}
            </strong>
          </span>
        </div>
        <div className="row">
          <span className="k">you receive (≈)</span>
          <span className="v ok">
            <strong>
              {fmt(amountOut, tokenOut.decimals)} {tokenOut.symbol}
            </strong>
          </span>
        </div>
        <div className="row">
          <span className="k">venue</span>
          <span className="v">
            {permitTx.venue} (sign permit + assemble + send)
          </span>
        </div>
        <div className="row">
          <span className="k">slippage</span>
          <span className="v">
            {(slippageBps / 100).toFixed(2)}%{" "}
            <span className="muted">({slippageBps} bps)</span>
          </span>
        </div>
        <div className="row">
          <span className="k">chain</span>
          <span className="v">
            {chain.name} <span className="muted">({chain.chainId})</span>
          </span>
        </div>
        <div className="row">
          <span className="k">spender (Permit2)</span>
          <span className="v">{permitTx.spender}</span>
        </div>
      </div>

      {wrongChain && !chainErr && (
        <p className="pending">
          ⚠ wallet is on chain {connectedChainId}; click any button to switch
          to {chain.name}.
        </p>
      )}
      {chainErr && <p className="err">{chainErr}</p>}

      {needsApprove && (
        <div className="panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            step 1 — approve {tokenIn.symbol} for Permit2
          </h2>
          <div className="muted" style={{ marginBottom: 12 }}>
            Allowance currently {fmt(approval!.current, tokenIn.decimals)}, need{" "}
            {fmt(approval!.required, tokenIn.decimals)}. Approving Permit2
            once lets future swaps reuse the same allowance — only the
            EIP-712 permit signature changes per-swap.
          </div>
          <button
            disabled={
              !address ||
              step !== "approve" ||
              approveHook.isPending ||
              approveReceipt.isLoading
            }
            onClick={clickApprove}
          >
            {step !== "approve"
              ? "✓ approved"
              : approveHook.isPending
                ? "confirm in wallet…"
                : approveReceipt.isLoading
                  ? "waiting for confirmation…"
                  : `approve ${tokenIn.symbol}`}
          </button>
          {approveHook.data && (
            <div className="muted" style={{ marginTop: 8 }}>
              <a
                href={explorerTxUrl(approveHook.data)}
                target="_blank"
                rel="noreferrer"
              >
                {approveHook.data}
              </a>
            </div>
          )}
          {(approveHook.error ?? approveReceipt.error) && (
            <div className="err" style={{ marginTop: 8 }}>
              {(approveHook.error ?? approveReceipt.error)!.message}
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
          {needsApprove ? "step 2 — sign permit" : "step 1 — sign permit"}
        </h2>
        <div className="muted" style={{ marginBottom: 12 }}>
          Sign the Permit2 PermitSingle (EIP-712). The CLI will then
          POST the signature to the Uniswap Trading API to assemble the
          Universal Router calldata.
        </div>
        <button
          disabled={
            !address ||
            (needsApprove && !approveReceipt.isSuccess) ||
            step !== "sign" ||
            sigHook.isPending
          }
          onClick={clickSign}
        >
          {step === "assemble"
            ? "assembling tx…"
            : step === "swap" || step === "done"
              ? "✓ signed & assembled"
              : sigHook.isPending
                ? "sign in wallet…"
                : "sign permit"}
        </button>
        {assembleErr && (
          <div className="err" style={{ marginTop: 8 }}>
            {assembleErr}
          </div>
        )}
      </div>

      {(step === "swap" || step === "done") && assembled && (
        <div className="panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
            {needsApprove ? "step 3 — send swap" : "step 2 — send swap"}
          </h2>
          <div className="row">
            <span className="k">to</span>
            <span className="v">{assembled.to}</span>
          </div>
          <div className="row">
            <span className="k">data</span>
            <span className="v muted">{assembled.data.length / 2 - 1} bytes</span>
          </div>
          <button
            disabled={
              !address ||
              step === "done" ||
              swapHook.isPending ||
              swapReceipt.isLoading
            }
            onClick={clickSwap}
          >
            {step === "done"
              ? "✓ swap confirmed"
              : swapHook.isPending
                ? "confirm in wallet…"
                : swapReceipt.isLoading
                  ? "waiting for confirmation…"
                  : "send"}
          </button>
          {swapHook.data && (
            <div className="muted" style={{ marginTop: 8 }}>
              <a
                href={explorerTxUrl(swapHook.data)}
                target="_blank"
                rel="noreferrer"
              >
                {swapHook.data}
              </a>
            </div>
          )}
          {(swapHook.error ?? swapReceipt.error) && (
            <div className="err" style={{ marginTop: 8 }}>
              {(swapHook.error ?? swapReceipt.error)!.message}
              <button
                style={{ marginLeft: 12 }}
                onClick={() =>
                  reportDone(sid, {
                    kind: "error",
                    error: (swapHook.error ?? swapReceipt.error)!.message,
                    venue: permitTx.venue,
                    chainId: chain.chainId,
                  })
                }
              >
                report &amp; close
              </button>
            </div>
          )}
          {step === "done" && (
            <p className="ok" style={{ marginTop: 12 }}>
              Reported back to the CLI — you can close this tab.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

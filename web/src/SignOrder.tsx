import { useEffect, useRef, useState } from "react";
import {
  useAccount,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import type { Hex } from "viem";
import type { ApprovalInfo, ChainMeta, SwapOrder, TokenMeta } from "./payload";
import { reportDone } from "./api";
import { orderExplorerUrl } from "./cowExplorer";
import { ExecStatusView, type ExecPhase } from "./dapp/ExecStatus";
import type { SendTxRun } from "./SendTx";
import { useTxReceipt } from "./useTxReceipt";

// Signs the EIP-712 typed data, splices the signature into the
// bodyTemplate at `signature`, POSTs to submit.url, then reports the
// returned id/hash back to the CLI.
export function SignOrder({
  sid,
  order,
  chain,
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  minAmountOut,
  slippageBps,
  approval,
  autoStart = false,
  compact = false,
  onPhase,
}: {
  sid: string;
  order: SwapOrder;
  chain: ChainMeta;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string;
  amountOut: string;
  minAmountOut?: string;
  slippageBps: number;
  approval: ApprovalInfo | null;
  // Interactive dApp: auto-fire (approve → sign + submit) and render compact.
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
  const [submitState, setSubmitState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "ok"; orderId: string }
    | { kind: "err"; message: string }
  >({ kind: "idle" });

  // Network-switch failure (rejected chain prompt, or the wallet threw). Its
  // own state so it feeds the same error channel as sign/submit errors —
  // without it the panel sat on "opening your wallet…" forever, since neither
  // sendTransaction nor signTypedData was ever reached.
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
      console.warn(`SignOrder: switch to chain ${chain.chainId} failed`, e);
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
    const td = order.typedData;
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
      setSubmitState({
        kind: "err",
        message: (e as Error).message ?? "sign failed",
      });
      return;
    }

    setSubmitState({ kind: "submitting" });
    const body = { ...order.submit.bodyTemplate, signature: sig };
    try {
      const res = await fetch(order.submit.url, {
        method: order.submit.method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        setSubmitState({
          kind: "err",
          message: `${order.submit.url} → ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
        });
        await reportDone(sid, {
          kind: "error",
          error: `submit failed: ${res.status} ${res.statusText}`,
          venue: order.venue,
          chainId: chain.chainId,
        });
        return;
      }
      // Try to extract an order id (CoW) or order hash; fall back to the
      // raw response text. Each venue returns its own shape.
      let orderId = text.trim().replace(/^"|"$/g, "");
      try {
        const j = JSON.parse(text);
        orderId = j.orderId ?? j.uid ?? j.id ?? orderId;
      } catch {
        // not JSON — keep as-is
      }
      setSubmitState({ kind: "ok", orderId });
      await reportDone(sid, {
        kind: "order",
        orderId,
        venue: order.venue,
        chainId: chain.chainId,
      });
    } catch (e) {
      setSubmitState({
        kind: "err",
        message: (e as Error).message ?? "submit failed",
      });
      await reportDone(sid, {
        kind: "error",
        error: (e as Error).message ?? "submit failed",
        venue: order.venue,
        chainId: chain.chainId,
      });
    }
  }

  // ── autoStart: approve (if needed) → sign + submit, no second click. Refs
  // guard each leg against double-firing across re-renders.
  const autoApproveFired = useRef(false);
  const autoSignFired = useRef(false);
  useEffect(() => {
    if (!autoStart || !address) return;
    if (needsApprove && !approveReceipt.isSuccess) {
      if (!autoApproveFired.current && !approveHook.isPending) {
        autoApproveFired.current = true;
        void clickApprove();
      }
      return;
    }
    if (
      !autoSignFired.current &&
      !sigHook.isPending &&
      submitState.kind !== "ok" &&
      submitState.kind !== "submitting"
    ) {
      autoSignFired.current = true;
      void clickSign();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, address, needsApprove, approveReceipt.isSuccess]);

  const approving = needsApprove && !approveReceipt.isSuccess;
  const runError =
    chainErr ??
    (submitState.kind === "err"
      ? submitState.message
      : (approveHook.error?.message ?? approveReceipt.error?.message ?? null));
  const runStage: SendTxRun["stage"] =
    submitState.kind === "ok"
      ? "done"
      : runError
        ? "error"
        : approving
          ? "approve"
          : "swap";
  const runPending = approving ? approveHook.isPending : sigHook.isPending;
  const runConfirming = approving
    ? approveReceipt.isLoading
    : submitState.kind === "submitting";
  const explorerHref =
    submitState.kind === "ok"
      ? orderExplorerUrl({
          venue: order.venue,
          chainId: chain.chainId,
          orderId: submitState.orderId,
        })
      : null;
  const explorerUrl = explorerHref ?? undefined;

  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  useEffect(() => {
    onPhaseRef.current?.({
      stage: runStage,
      pending: runPending,
      confirming: runConfirming,
      error: runError,
      ...(explorerUrl ? { explorerUrl } : {}),
    });
  }, [runStage, runPending, runConfirming, runError, explorerUrl]);

  const fmt = (raw: string, dec: number) => {
    try {
      const n = BigInt(raw);
      const base = 10n ** BigInt(dec);
      const whole = n / base;
      const frac = n % base;
      const fracStr = frac.toString().padStart(dec, "0").slice(0, 6);
      return `${whole}.${fracStr.replace(/0+$/, "") || "0"}`;
    } catch {
      return raw;
    }
  };

  // Interactive dApp: compact, auto-fired status (no duplicate order panel).
  // Receipt errors matter: useTxReceipt rejects when the mined receipt has
  // status "reverted", so approveHook.error stays null after a
  // broadcast-then-reverted approve. Without approveReceipt.error the panel
  // stuck on "opening your wallet…" with no retry.
  if (compact) {
    const phase: ExecPhase =
      submitState.kind === "ok" ? "done" : runError ? "error" : "working";
    const text = approving
      ? approveHook.isPending
        ? `confirm ${tokenIn.symbol} approval in your wallet…`
        : approveReceipt.isLoading
          ? `approving ${tokenIn.symbol}…`
          : `approve ${tokenIn.symbol} in your wallet…`
      : submitState.kind === "submitting"
        ? "submitting order to the solver…"
        : sigHook.isPending
          ? "sign the order in your wallet…"
          : "opening your wallet…";
    const onRetry = approving
      ? () => {
          autoApproveFired.current = false;
          void clickApprove();
        }
      : () => {
          autoSignFired.current = false;
          void clickSign();
        };
    // wrongChainName: suppressed while chainErr is set — that message already
    // spells out "switch to <chain> and retry", no need to stack both.
    return (
      <ExecStatusView
        phase={phase}
        text={text}
        doneText="Order submitted to the solver"
        error={runError}
        txHash={
          submitState.kind === "ok"
            ? submitState.orderId
            : (approveHook.data ?? null)
        }
        href={submitState.kind === "ok" ? explorerHref : undefined}
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
        {minAmountOut && (
          <div className="row">
            <span className="k">minimum</span>
            <span className="v">
              {fmt(minAmountOut, tokenOut.decimals)} {tokenOut.symbol}
            </span>
          </div>
        )}
        <div className="row">
          <span className="k">venue</span>
          <span className="v">{order.venue} (intent / sign + POST)</span>
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
          <span className="k">spender</span>
          <span className="v">{order.spender}</span>
        </div>
        <div className="row">
          <span className="k">submit</span>
          <span className="v muted">POST {order.submit.url}</span>
        </div>
        <div className="row">
          <span className="k">valid until</span>
          <span className="v muted">
            {new Date(order.validUntilSec * 1000).toISOString()}
          </span>
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
            step 1 — approve {tokenIn.symbol} for {order.spender}
          </h2>
          <div className="muted" style={{ marginBottom: 12 }}>
            Allowance currently {fmt(approval!.current, tokenIn.decimals)}, need{" "}
            {fmt(approval!.required, tokenIn.decimals)}.
          </div>
          <button
            disabled={
              !address || approveHook.isPending || approveReceipt.isLoading ||
              approveReceipt.isSuccess
            }
            onClick={clickApprove}
          >
            {approveReceipt.isSuccess
              ? "✓ approved"
              : approveHook.isPending
                ? "confirm in wallet…"
                : approveReceipt.isLoading
                  ? "waiting for confirmation…"
                  : `approve ${tokenIn.symbol}`}
          </button>
          {(approveHook.error ?? approveReceipt.error) && (
            <div className="err" style={{ marginTop: 8 }}>
              {(approveHook.error ?? approveReceipt.error)!.message}
            </div>
          )}
        </div>
      )}

      <div className="panel">
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
          {needsApprove ? "step 2 — sign & submit order" : "sign & submit order"}
        </h2>
        <button
          disabled={
            !address ||
            (needsApprove && !approveReceipt.isSuccess) ||
            sigHook.isPending ||
            submitState.kind === "submitting" ||
            submitState.kind === "ok"
          }
          onClick={clickSign}
        >
          {submitState.kind === "ok"
            ? "✓ submitted"
            : submitState.kind === "submitting"
              ? "POSTing to relayer…"
              : sigHook.isPending
                ? "sign in wallet…"
                : "sign & submit"}
        </button>
        {submitState.kind === "ok" && (
          <p className="ok" style={{ marginTop: 12 }}>
            order id: <code>{submitState.orderId}</code>
            {explorerHref && (
              <>
                {" "}
                <a href={explorerHref} target="_blank" rel="noreferrer">
                  {new URL(explorerHref).host}
                </a>
              </>
            )}
            <br />
            Reported back to the CLI — you can close this tab.
          </p>
        )}
        {submitState.kind === "err" && (
          <div className="err" style={{ marginTop: 8 }}>
            {submitState.message}
          </div>
        )}
      </div>
    </div>
  );
}

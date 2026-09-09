import { useEffect, useRef, useState } from "react";
import {
  useAccount,
  useSendTransaction,
  useSwitchChain,
} from "wagmi";
import type { Hex } from "viem";
import type {
  ApprovalInfo,
  ChainMeta,
  SimulateOutcome,
  SwapTx,
  TokenMeta,
} from "./payload";
import { reportDone, simulate } from "./api";
import { ExecStatusView, type ExecPhase, type SummaryRow } from "./dapp/ExecStatus";
import { Icon, IconKeyframes } from "./dapp/icons";
import { useTxReceipt } from "./useTxReceipt";

// Inline spinner for the legacy panel's "waiting for confirmation…" button
// states. Needs <IconKeyframes /> mounted in the same tree — the legacy
// --browser page never renders InteractiveDapp (the only other mount point),
// so without it the arc would sit frozen.
function ButtonSpinner() {
  return (
    <Icon name="spinner" size={12} style={{ verticalAlign: -1.5, marginRight: 7 }} />
  );
}

// Live execution phase reported up to the orchestrator (interactive dApp) so the
// form's action button can mirror the real step — Approve… → Confirm… → done —
// instead of spinning on a static label forever.
export type SendTxRun = {
  stage: "approve" | "swap" | "done" | "error";
  pending: boolean; // wallet confirmation prompt is open
  confirming: boolean; // tx broadcast, waiting for the receipt
  error: string | null;
  explorerUrl?: string;
};

// keccak256("Transfer(address,address,uint256)") — ERC20 Transfer event topic0.
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Sum the ERC20 Transfer values from a mined receipt whose token is `tokenOut`
// and whose recipient is `to` — i.e. what the user actually received. Returns
// null for native output (no Transfer event is emitted) or when nothing matches,
// so the caller can fall back to the quoted amountOut.
function receivedFromLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  tokenOutAddress: string,
  to: string,
): bigint | null {
  if (tokenOutAddress.toLowerCase() === NATIVE_SENTINEL) return null;
  const toTopic = "0x" + to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let total = 0n;
  let matched = false;
  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenOutAddress.toLowerCase()) continue;
    if ((log.topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics[2] ?? "").toLowerCase() !== toTopic) continue;
    try {
      total += BigInt(log.data);
      matched = true;
    } catch {
      // Unparseable data field — skip this log rather than abort the summary.
    }
  }
  return matched ? total : null;
}

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// Format raw bigint string with token decimals → human (best-effort).
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

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// Mode is derived from the venue label set by the CLI:
//   - "wrap"  → ETH↔WETH short-circuit (deposit / withdraw on WETH9)
//   - "send"  → -a send action (ERC20 transfer or native value send)
//   - "swap"  → everything else (a real DEX route)
// Each mode tweaks the panel labels, button text, and which rows
// render — most importantly, send hides the "you receive" / slippage
// rows (they're meaningless for a transfer) and surfaces the recipient
// instead, since for ERC20 sends the destination is hidden in tx.data.
type Mode = "wrap" | "unwrap" | "send" | "swap";

function deriveMode(args: {
  venue: string;
  tokenInAddress: string;
  tokenOutAddress: string;
}): Mode {
  if (args.venue === "send") return "send";
  if (args.venue === "wrap") {
    return args.tokenInAddress.toLowerCase() === NATIVE_SENTINEL
      ? "wrap"
      : "unwrap";
  }
  return "swap";
}

type Step = "approve" | "swap" | "done";

export function SendTx({
  sid,
  venue,
  tx,
  chain,
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  recipient,
  slippageBps,
  approval,
  simulateEnabled,
  autoStart = false,
  compact = false,
  onPhase,
}: {
  sid: string;
  venue: string;
  tx: SwapTx;
  chain: ChainMeta;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string;
  amountOut: string;
  recipient: string | null;
  slippageBps: number;
  approval: ApprovalInfo | null;
  simulateEnabled: boolean;
  // Interactive dApp: auto-fire the wallet on mount (approve → swap) and render
  // a compact status line instead of the full sign-and-send panel.
  autoStart?: boolean;
  compact?: boolean;
  // Interactive dApp: report the live step up so the action button mirrors it.
  onPhase?: (run: SendTxRun) => void;
}) {
  const { address, chainId: connectedChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();

  const mode = deriveMode({
    venue,
    tokenInAddress: tokenIn.address,
    tokenOutAddress: tokenOut.address,
  });

  // The two-tx flow: approve (optional) → swap. Track which step we're on.
  const needsApprove = !!approval && approval.needed && !!approval.approveTx;
  const [step, setStep] = useState<Step>(needsApprove ? "approve" : "swap");

  // Network-switch failure (user rejected the wallet's chain prompt, or the
  // wallet threw). Feeds the same error channel as send/receipt errors —
  // without it the flow sat on "Confirm in your wallet…" forever, no error,
  // no retry, because sendTransaction was never reached.
  const [chainErr, setChainErr] = useState<string | null>(null);

  // eth_simulateV1 — server-side prank+approve+swap. The result is
  // advisory (it's the server's RPC, not the user's wallet) so we don't
  // gate broadcasting on it; just show below the button.
  const [simState, setSimState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "result"; outcome: SimulateOutcome }
  >({ kind: "idle" });

  async function clickSimulate() {
    setSimState({ kind: "running" });
    const outcome = await simulate(sid);
    setSimState({ kind: "result", outcome });
  }

  // Approve tx
  const approveTx = approval?.approveTx ?? null;
  const approveHook = useSendTransaction();
  // Dual-path receipt: wagmi block-watcher + independent public-RPC poll
  // (survives MEV-protected / private-mempool send RPCs — see useTxReceipt).
  const approveReceipt = useTxReceipt({
    hash: approveHook.data,
    chainId: chain.chainId,
  });

  // Swap tx
  const swapHook = useSendTransaction();
  const swapReceipt = useTxReceipt({
    hash: swapHook.data,
    chainId: chain.chainId,
  });

  // Advance step machine when receipts land.
  useEffect(() => {
    if (step === "approve" && approveReceipt.isSuccess) setStep("swap");
  }, [step, approveReceipt.isSuccess]);

  useEffect(() => {
    if (step === "swap" && swapReceipt.isSuccess && swapHook.data) {
      reportDone(sid, {
        kind: "tx",
        hash: swapHook.data,
        venue,
        chainId: chain.chainId,
      });
      setStep("done");
    }
  }, [step, swapReceipt.isSuccess, swapHook.data, sid, venue, chain.chainId]);

  // ── Report the live step up to the orchestrator (interactive dApp). The
  // action button mirrors this instead of spinning on a static label.
  // Receipt errors matter as much as send errors: useTxReceipt (like wagmi)
  // REJECTS when the mined receipt has status "reverted", so a
  // broadcast-then-reverted swap surfaces on swapReceipt.error
  // (swapHook.error stays null — the send succeeded). Without it the panel
  // silently fell back to "opening your wallet…" after an on-chain revert,
  // with no error and no retry.
  const approving = needsApprove && step === "approve";
  const runError =
    chainErr ??
    swapHook.error?.message ??
    approveHook.error?.message ??
    swapReceipt.error?.message ??
    approveReceipt.error?.message ??
    null;
  const runStage: SendTxRun["stage"] =
    step === "done" ? "done" : runError ? "error" : approving ? "approve" : "swap";
  const runPending = approving ? approveHook.isPending : swapHook.isPending;
  const runConfirming = approving
    ? approveReceipt.isLoading
    : swapReceipt.isLoading;

  // onPhase identity may churn each render; keep it in a ref so the effect fires
  // on actual state transitions, not on every parent re-render.
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

  // ── autoStart: fire the wallet without a second click. Approve (if needed)
  // fires first; once its receipt advances `step` to "swap", the swap fires.
  // Refs guard each leg so it never double-fires across re-renders.
  const autoApproveFired = useRef(false);
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
    if (step === "swap" && !autoSwapFired.current && !swapHook.isPending) {
      autoSwapFired.current = true;
      void clickSwap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, address, step, needsApprove]);

  const wrongChain =
    typeof connectedChainId === "number" && connectedChainId !== chain.chainId;

  // Returns false when the switch was rejected/failed — callers MUST abort so
  // the panel drops out of its busy state instead of waiting on a wallet
  // prompt that will never open. The auto-start refs stay armed (no prompt
  // loop); the retry button clears them.
  async function ensureChain(): Promise<boolean> {
    setChainErr(null);
    if (!wrongChain) return true;
    try {
      await switchChainAsync({ chainId: chain.chainId });
      return true;
    } catch (e) {
      console.warn(`SendTx: switch to chain ${chain.chainId} failed`, e);
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

  async function clickSwap() {
    if (!(await ensureChain())) return;
    swapHook.sendTransaction({
      to: tx.to as Hex,
      data: tx.data as Hex,
      value: BigInt(tx.value || "0"),
      gas: tx.gas ? BigInt(tx.gas) : undefined,
      chainId: chain.chainId,
    });
  }

  const explorerTxUrl = (h: string) => `${chain.explorer}/tx/${h}`;

  // Per-mode label/copy. The "value" for the input amount uses
  // tx.value when non-zero (native flows), else amountIn formatted with
  // tokenIn.decimals (ERC20 flows). Wrap → tokenOut symbol is the
  // wrapped-native (W<X>); unwrap → tokenOut is the native symbol.
  const inputAmountLabel =
    tx.value !== "0" && tx.value !== "0x0" && tx.value !== "0x00"
      ? `${fmt(tx.value, 18)} ${chain.nativeSymbol}`
      : `${fmt(amountIn, tokenIn.decimals)} ${tokenIn.symbol}`;
  const outputAmountLabel = `${fmt(amountOut, tokenOut.decimals)} ${tokenOut.symbol}`;

  const headers = (() => {
    if (mode === "wrap") {
      return {
        title: needsApprove ? "step 2 — wrap" : "wrap",
        button: "wrap",
        confirmed: "Wrapped",
        topPay: "you wrap",
        topReceive: "you receive",
      };
    }
    if (mode === "unwrap") {
      return {
        title: needsApprove ? "step 2 — unwrap" : "unwrap",
        button: "unwrap",
        confirmed: "Unwrapped",
        topPay: "you unwrap",
        topReceive: "you receive",
      };
    }
    if (mode === "send") {
      return {
        title: needsApprove ? "step 2 — send" : "send",
        button: "send",
        confirmed: "Sent",
        topPay: "you send",
        topReceive: "to",
      };
    }
    return {
      title: needsApprove ? "step 2 — swap" : "send swap",
      button: "send",
      confirmed: "Swap confirmed",
      topPay: "you pay",
      topReceive: "you receive (≈)",
    };
  })();

  // Interactive dApp: compact, auto-fired status (no duplicate details panel).
  if (compact) {
    const phase: ExecPhase =
      step === "done" ? "done" : runError ? "error" : "working";
    const text = approving
      ? approveHook.isPending
        ? `confirm ${tokenIn.symbol} approval in your wallet…`
        : approveReceipt.isLoading
          ? `approving ${tokenIn.symbol}…`
          : `approve ${tokenIn.symbol} in your wallet…`
      : swapHook.isPending
        ? "confirm in your wallet…"
        : swapReceipt.isLoading
          ? "waiting for confirmation…"
          : "opening your wallet…";
    const onRetry = approving
      ? () => {
          autoApproveFired.current = false;
          void clickApprove();
        }
      : () => {
          autoSwapFired.current = false;
          void clickSwap();
        };

    // Execution summary — built once the swap is mined. Shows what actually
    // moved (received parsed from Transfer logs, falling back to the quote),
    // plus block number and the on-chain network fee.
    //
    // Receipt field shapes vary across wallets/chains: blockNumber / gasUsed /
    // effectiveGasPrice can come back null or absent through an injected
    // wallet's RPC, and viem's runtime value won't always match the (non-null)
    // type. Guard EVERY field so a missing one drops only its row rather than
    // crashing the whole render (was: `receipt.blockNumber.toString()` on a
    // null blockNumber → "Cannot read properties of null (reading 'toString')").
    let summary: SummaryRow[] | undefined;
    if (step === "done") {
      const receipt = swapReceipt.data;
      const rows: SummaryRow[] = [];
      rows.push({
        label: mode === "send" ? "Sent" : "Paid",
        value: `− ${inputAmountLabel}`,
        tone: "neg",
      });
      if (mode === "send") {
        rows.push({ label: "To", value: shorten(recipient ?? tx.to) });
      } else {
        let got: bigint | null = null;
        try {
          const to = recipient ?? address ?? "";
          got = receipt?.logs
            ? receivedFromLogs(receipt.logs, tokenOut.address, to)
            : null;
        } catch {
          got = null;
        }
        rows.push({
          label: "Received",
          value:
            got !== null
              ? `+ ${fmt(got.toString(), tokenOut.decimals)} ${tokenOut.symbol}`
              : `+ ${outputAmountLabel} (≈)`,
          tone: "pos",
        });
      }
      if (receipt?.blockNumber != null) {
        try {
          rows.push({ label: "Block", value: `#${receipt.blockNumber.toString()}` });
        } catch {
          // non-bigint blockNumber — drop the row.
        }
      }
      if (receipt?.gasUsed != null && receipt?.effectiveGasPrice != null) {
        try {
          const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
          rows.push({
            label: "Network fee",
            value: `${fmt(fee.toString(), 18)} ${chain.nativeSymbol}`,
            tone: "muted",
          });
        } catch {
          // gasUsed / effectiveGasPrice not numeric — drop the fee row only.
        }
      }
      summary = rows;
    }

    // wrongChainName: suppressed while chainErr is set — that message already
    // spells out "switch to <chain> and retry", no need to stack both.
    return (
      <ExecStatusView
        phase={phase}
        text={text}
        doneText={headers.confirmed}
        error={runError}
        txHash={swapHook.data ?? approveHook.data ?? null}
        explorer={chain.explorer}
        onRetry={onRetry}
        wrongChainName={wrongChain && !chainErr ? chain.name : null}
        summary={summary}
      />
    );
  }

  return (
    <div>
      <IconKeyframes />
      <div className="panel">
        <div className="row">
          <span className="k">{headers.topPay}</span>
          <span className="v">
            <strong>{inputAmountLabel}</strong>
          </span>
        </div>
        {mode === "send" ? (
          <div className="row">
            <span className="k">{headers.topReceive}</span>
            <span className="v ok">
              <strong>{recipient ?? tx.to}</strong>
            </span>
          </div>
        ) : (
          <div className="row">
            <span className="k">{headers.topReceive}</span>
            <span className="v ok">
              <strong>{outputAmountLabel}</strong>
            </span>
          </div>
        )}
        {/* Slippage / route only matter for actual swaps. Wrap is 1:1
            by construction; send doesn't price anything. */}
        {mode === "swap" && (
          <div className="row">
            <span className="k">slippage</span>
            <span className="v">
              {(slippageBps / 100).toFixed(2)}%{" "}
              <span className="muted">({slippageBps} bps)</span>
            </span>
          </div>
        )}
        <div className="row">
          <span className="k">chain</span>
          <span className="v">
            {chain.name} <span className="muted">({chain.chainId})</span>
          </span>
        </div>
        <div className="row">
          <span className="k">to (tx target)</span>
          <span className="v">{tx.to}</span>
        </div>
        {/* Spender row only adds noise for wrap/send (it equals tx.to
            and there's no allowance check anyway). */}
        {mode === "swap" && (
          <div className="row">
            <span className="k">spender</span>
            <span className="v">{tx.spender}</span>
          </div>
        )}
        <div className="row">
          <span className="k">data</span>
          <span className="v muted">
            {tx.data.length / 2 - 1} bytes
            {mode === "wrap" && " (deposit)"}
            {mode === "unwrap" && " (withdraw)"}
            {mode === "send" && tokenIn.address.toLowerCase() !== NATIVE_SENTINEL && " (transfer)"}
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
            step 1 — approve {tokenIn.symbol}
          </h2>
          <div className="muted" style={{ marginBottom: 12 }}>
            Allowance currently {fmt(approval!.current, tokenIn.decimals)}, need{" "}
            {fmt(approval!.required, tokenIn.decimals)}.
          </div>
          <button
            disabled={
              !address || step !== "approve" || approveHook.isPending ||
              approveReceipt.isLoading
            }
            onClick={clickApprove}
          >
            {step !== "approve"
              ? "✓ approved"
              : approveHook.isPending
                ? "confirm in wallet…"
                : approveReceipt.isLoading
                  ? (
                      <>
                        <ButtonSpinner />
                        waiting for confirmation…
                      </>
                    )
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
          {approveHook.error && (
            <div className="err" style={{ marginTop: 8 }}>
              {approveHook.error.message}
            </div>
          )}
        </div>
      )}

      {/* eth_simulateV1 — pre-flight the swap with a pranked balance.
          Only rendered when the CLI was invoked with --simulate /
          --simu. Default browser sessions ship a clean send/sign UI
          without the eth_simulateV1 panel. */}
      {simulateEnabled && (
        <div className="panel">
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>simulate</h2>
          <div className="muted" style={{ marginBottom: 12 }}>
            Pre-flight via <code>eth_simulateV1</code> using the CLI's RPC.
            Pranks your <code>{tokenIn.symbol}</code> balance, runs the
            approve + swap in one batch, reports actual{" "}
            <code>{tokenOut.symbol}</code> received and any revert reason.
            Doesn't broadcast anything.
          </div>
          <button
            onClick={clickSimulate}
            disabled={simState.kind === "running"}
          >
            {simState.kind === "running" ? "simulating…" : "simulate"}
          </button>
          {simState.kind === "result" && (
            <SimulateBlock
              outcome={simState.outcome}
              tokenIn={tokenIn}
              tokenOut={tokenOut}
              amountIn={amountIn}
            />
          )}
        </div>
      )}

      <div className="panel">
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>{headers.title}</h2>
        <button
          disabled={
            !address ||
            step === "approve" ||
            step === "done" ||
            swapHook.isPending ||
            swapReceipt.isLoading
          }
          onClick={clickSwap}
        >
          {step === "done"
            ? headers.confirmed
            : swapHook.isPending
              ? "confirm in wallet…"
              : swapReceipt.isLoading
                ? (
                    <>
                      <ButtonSpinner />
                      waiting for confirmation…
                    </>
                  )
                : headers.button}
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
                  venue,
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
    </div>
  );
}

// Convert a raw bigint string with `decimals` into a JS number for
// USD math. Loses precision past ~15 sig figs but that's irrelevant
// for a USD display rounded to cents.
function toNumber(raw: string, decimals: number): number {
  try {
    const n = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = n / base;
    const frac = n % base;
    return Number(whole) + Number(frac) / Number(base);
  } catch {
    return 0;
  }
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  // Cents under $1, otherwise commas + 2dp.
  const body =
    abs < 1
      ? abs.toFixed(4)
      : abs.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
  return `${sign}$${body}`;
}

function SimulateBlock({
  outcome,
  tokenIn,
  tokenOut,
  amountIn,
}: {
  outcome: SimulateOutcome;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string;
}) {
  if (outcome.kind === "skipped") {
    return (
      <div className="muted" style={{ marginTop: 12 }}>
        skipped — {outcome.reason}
      </div>
    );
  }
  if (outcome.kind === "error") {
    return (
      <div className="err" style={{ marginTop: 12 }}>
        error — {outcome.message}
      </div>
    );
  }
  const swapOk = outcome.swapStatus === "ok";

  // Per-side USD: multiply the human amount by the per-token USD price
  // when it's available. Null = "—" in the right column, no PnL header.
  const sentAmount = toNumber(amountIn, tokenIn.decimals);
  const receivedAmount = swapOk
    ? toNumber(outcome.tokenOutReceived, tokenOut.decimals)
    : 0;
  const sentUsd =
    outcome.tokenInPriceUsd !== null ? sentAmount * outcome.tokenInPriceUsd : null;
  const receivedUsd =
    swapOk && outcome.tokenOutPriceUsd !== null
      ? receivedAmount * outcome.tokenOutPriceUsd
      : null;
  const pnlUsd =
    sentUsd !== null && receivedUsd !== null ? receivedUsd - sentUsd : null;

  return (
    <div style={{ marginTop: 16 }}>
      {/* Header row: title left, net P&L right (when both prices known). */}
      <div
        className="row"
        style={{
          borderBottom: "1px solid var(--border)",
          paddingBottom: 8,
          marginBottom: 4,
        }}
      >
        <span className="k">
          <strong>simulation results</strong>
        </span>
        {pnlUsd !== null && (
          <span className={pnlUsd >= 0 ? "v ok" : "v err"}>
            <strong>{fmtUsd(pnlUsd)}</strong>
          </span>
        )}
      </div>

      {/* Sent row — red minus, amount + symbol left, USD right. */}
      <div className="row" style={{ paddingTop: 10 }}>
        <span className="v err" style={{ flex: 1, textAlign: "left" }}>
          <strong>
            − {fmt(amountIn, tokenIn.decimals)} {tokenIn.symbol}
          </strong>
        </span>
        <span className="v muted">
          {sentUsd !== null ? `≈ ${fmtUsd(sentUsd)}` : "—"}
        </span>
      </div>

      {/* Received row — green plus, amount + symbol left, USD right.
          Hidden when the swap reverted (no balance delta to show). */}
      {swapOk && (
        <div className="row">
          <span className="v ok" style={{ flex: 1, textAlign: "left" }}>
            <strong>
              + {fmt(outcome.tokenOutReceived, tokenOut.decimals)}{" "}
              {tokenOut.symbol}
            </strong>
          </span>
          <span className="v muted">
            {receivedUsd !== null ? `≈ ${fmtUsd(receivedUsd)}` : "—"}
          </span>
        </div>
      )}

      {/* Status / gas / revert info — muted, smaller, below the trade. */}
      <div
        className="muted"
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid var(--border)",
          fontSize: 12,
        }}
      >
        <div className="row" style={{ padding: "2px 0" }}>
          <span>approve</span>
          <span>
            {outcome.approveStatus}
            {outcome.approveGasUsed ? ` · ${outcome.approveGasUsed} gas` : ""}
          </span>
        </div>
        <div className="row" style={{ padding: "2px 0" }}>
          <span>swap</span>
          <span className={swapOk ? "" : "err"}>
            {outcome.swapStatus}
            {outcome.swapGasUsed ? ` · ${outcome.swapGasUsed} gas` : ""}
          </span>
        </div>
        {outcome.swapRevertReason && (
          <div className="row" style={{ padding: "2px 0" }}>
            <span>revert</span>
            <span className="err" style={{ wordBreak: "break-all" }}>
              {outcome.swapRevertReason}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

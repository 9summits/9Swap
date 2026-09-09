import React from "react";
import { Button } from "../ds/components/Button";
import { Input } from "../ds/components/Input";
import { TokenIcon } from "./TokenIcon";
import { Icon } from "./icons";
import { vmeta, formatUnits, formatUsd, toNumber } from "./venues";
import { SettingsPopover } from "./SettingsPopover";
import type { FormMode, EditSide } from "./useQuote";
import { toBaseUnits, NATIVE_SENTINEL } from "./useQuote";
import { useCoingeckoRate, cgDiffColor } from "./useCoingeckoRate";
import { buildCliCommand } from "./cliCommand";
import { copyText } from "./copyText";
import type { ChainMeta, QuoteResponse, TokenInfo, VenueMeta } from "./types";

// <SwapForm> — the editable LEFT pane of the Direction-A two-pane aggregator,
// ported from the prototype's TokenFlow + Summary + ActionZone
// (/tmp/9s-design/ui_kits/swap/app.jsx) and made interactive:
//   · a small Swap / Send mode tab;
//   · "You pay" — amount Input + MAX (from balance) + live USD value;
//   · a token-pill that opens the <TokenSelector> for each side;
//   · a flip button (swaps the pair);
//   · "You receive ≈" — live from the quote (or synthesized 1:1 for wrap);
//   · for Send, a recipient address field replaces the receive side;
//   · a settings popover (slippage / venue filters / allow-async);
//   · summary rows (rate, via venue, max slippage);
//   · the action button (Connect → Approve → Swap/Sign), driven by the
//     orchestrator's wallet + execution state.
//
// All execution (approve/sign/send) is owned by the orchestrator, which renders
// the existing <SendTx>/<SignOrder>/<SignPermitTx> below this form once a
// Payload is built. The action button here only kicks that off.

const ACTION_COPY: Record<
  FormMode,
  { pay: string; recv: string; verb: string }
> = {
  // swap pay/recv labels are overridden per side below (exact-in vs exact-out);
  // these are the fallbacks + the shared verb.
  swap: { pay: "You pay", recv: "You receive (≈)", verb: "Swap" },
  wrap: { pay: "You wrap", recv: "You receive", verb: "Wrap" },
  unwrap: { pay: "You unwrap", recv: "You receive", verb: "Unwrap" },
  send: { pay: "You send", recv: "To", verb: "Send" },
};

export type SwapFormProps = {
  // chain (for the CoinGecko reference rate: chainId + wrappedNative)
  chain: ChainMeta;
  // pair
  tokenIn: TokenInfo | null;
  tokenOut: TokenInfo | null;
  onPickIn: () => void;
  onPickOut: () => void;
  onFlip: () => void;
  // amount — the single "active" amount the user typed. It denominates the PAY
  // side (tokenIn) when editSide==="pay" and the RECEIVE side (tokenOut) when
  // editSide==="receive". The inactive side shows the quote's (≈) value.
  amount: string;
  onAmount: (v: string) => void;
  // Which field is the active input. Typing in / focusing a field makes it
  // active (pay → exact-in / sell; receive → exact-out / buy). Only meaningful
  // in swap mode — wrap/unwrap/send keep the receive side read-only (pay-active).
  editSide: EditSide;
  onEditSide: (s: EditSide) => void;
  // balances (base-units strings, keyed by lowercased address)
  balances: Record<string, string> | null;
  // quote / mode
  quote: QuoteResponse | null;
  quoteLoading: boolean;
  quoteError: string | null;
  mode: FormMode;
  synthAmountOut: string | null;
  // selected venue (for the summary "Via" row)
  selectedVenue: string | null;
  // settings (passed straight through to <SettingsPopover>)
  slippageBps: number;
  onSlippageBps: (bps: number) => void;
  venues: VenueMeta[];
  enabledVenues: string[];
  onToggleVenue: (venue: string) => void;
  onSetAllVenues: (on: boolean) => void;
  // Read-only: drives how intent venues render in the popover (the toggle itself
  // lives in the RoutesPane header).
  allowAsync: boolean;
  // Copy-CLI extras (Settings → Copy CLI) → `buildCliCommand`.
  cliJson: boolean;
  onCliJson: (v: boolean) => void;
  cliData: boolean;
  onCliData: (v: boolean) => void;
  cliSimu: boolean;
  onCliSimu: (v: boolean) => void;
  // send mode
  isSend: boolean;
  onIsSend: (v: boolean) => void;
  recipient: string;
  onRecipient: (v: string) => void;
  // wallet + action
  connected: boolean;
  /** Connected address for the copied CLI `--from` flag (null when disconnected). */
  senderAddress?: string | null;
  onConnect: () => void;
  onAction: () => void; // build + execute (orchestrator)
  actionBusy: boolean;
  actionLabel?: string;
  // Terminal success state: button shows the confirmed label, disabled, no spinner.
  actionDone?: boolean;
  actionHref?: string;
};

// A 0x 20-byte address (loose check for the recipient field).
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function SwapForm(props: SwapFormProps) {
  const {
    chain,
    tokenIn,
    tokenOut,
    onPickIn,
    onPickOut,
    onFlip,
    amount,
    onAmount,
    editSide,
    onEditSide,
    balances,
    quote,
    quoteLoading,
    quoteError,
    mode,
    synthAmountOut,
    selectedVenue,
    slippageBps,
    onSlippageBps,
    venues,
    enabledVenues,
    onToggleVenue,
    onSetAllVenues,
    allowAsync,
    cliJson,
    onCliJson,
    cliData,
    onCliData,
    cliSimu,
    onCliSimu,
    isSend,
    onIsSend,
    recipient,
    onRecipient,
    connected,
    senderAddress = null,
    onConnect,
    onAction,
    actionBusy,
    actionLabel,
    actionDone = false,
    actionHref,
  } = props;

  const copy = ACTION_COPY[mode];

  // Bad-rate gate (swap only): a swap executing far below the CoinGecko mid pops
  // a type-to-confirm modal BEFORE any build/wallet prompt. Open state only; the
  // modal is rendered conditionally so its typed text resets on every open (no
  // "already confirmed" memory — see needsRateConfirm below).
  const [rateConfirmOpen, setRateConfirmOpen] = React.useState(false);

  // ---- trade side / which amount field is the active input ----
  // buyMode = exact-out: only in a real swap with the RECEIVE field active.
  // wrap/unwrap/send keep the PAY side active (receive read-only) — exact-out is
  // out of scope there (PR7 §dApp).
  const buyMode = mode === "swap" && editSide === "receive";
  const payEditable = !buyMode; // pay is the typed input on sell / wrap / unwrap / send
  const recvEditable = buyMode; // receive is the typed input only on buy

  // Labels: exact-in marks the receive side (≈); exact-out marks the pay side
  // (≈). wrap/unwrap/send keep their fixed copy.
  const payLabel = mode !== "swap" ? copy.pay : buyMode ? "You pay (≈)" : "You pay";
  const recvLabel =
    mode !== "swap" ? copy.recv : buyMode ? "You receive" : "You receive (≈)";

  // ---- balances / MAX (only wired when the PAY side is the input; MAX writes
  // the pay amount, so it's meaningless while editing the receive side) ----
  const inBalRaw = tokenIn
    ? balances?.[tokenIn.address.toLowerCase()] ?? balances?.[tokenIn.address]
    : undefined;
  const inBalance =
    inBalRaw !== undefined && tokenIn
      ? formatUnits(inBalRaw, tokenIn.decimals)
      : null;

  // Spendable balance in base units: the full balance for ERC20s, minus a flat
  // gas reserve for the native token (so MAX / the 100% slider still leave enough
  // to pay for the swap tx). ponytail: flat per-native reserve; make it
  // gas-price-aware if mainnet high-gas ever leaves too little.
  const maxSpendableRaw: string | null = (() => {
    if (!tokenIn || inBalRaw === undefined) return null;
    if (tokenIn.address.toLowerCase() !== NATIVE_SENTINEL) return inBalRaw;
    const GAS_RESERVE: Record<string, string> = {
      ETH: "0.003", AVAX: "0.05", BNB: "0.005", HYPE: "0.05",
    };
    const reserve = toBaseUnits(GAS_RESERVE[tokenIn.symbol] ?? "0.003", tokenIn.decimals);
    if (!reserve) return inBalRaw;
    const net = BigInt(inBalRaw) - BigInt(reserve);
    return net > 0n ? net.toString() : "0";
  })();

  // Set the amount to a fraction (0..1) of the spendable balance. pct=1 ⇒ MAX.
  // formatUnits groups thousands with commas; the input + toBaseUnits reject
  // commas, so strip them to yield a clean decimal.
  function setAmountFraction(frac: number) {
    // No-op when nothing is spendable (e.g. native balance below the gas
    // reserve) — clicking MAX should not blank the field to "0".
    if (!tokenIn || maxSpendableRaw === null || BigInt(maxSpendableRaw) === 0n) return;
    const raw = (BigInt(maxSpendableRaw) * BigInt(Math.round(frac * 1e6))) / 1_000_000n;
    onAmount(formatUnits(raw, tokenIn.decimals, tokenIn.decimals).replace(/,/g, ""));
  }

  function setMax() {
    setAmountFraction(1);
  }

  // Current amount as a % of spendable balance, for the slider position (0..100).
  // Only ever shown while the pay side is the input, so `amount` is the tokenIn
  // amount here.
  const amountPct: number = (() => {
    if (!tokenIn || maxSpendableRaw === null) return 0;
    const max = BigInt(maxSpendableRaw);
    if (max === 0n) return 0;
    const base = toBaseUnits(amount, tokenIn.decimals);
    if (!base) return 0;
    const pct = Number((BigInt(base) * 10000n) / max) / 100;
    return Math.max(0, Math.min(100, pct));
  })();
  // MAX + slider: pay side only, exact-in only (PR7 §dApp item 4).
  const showSlider =
    payEditable && !isSend && maxSpendableRaw !== null && BigInt(maxSpendableRaw) > 0n;

  // ---- amount input guard (digits + single dot) → the single `amount` ----
  function cleanAmount(v: string): string | null {
    const next = v.replace(/\s/g, ""); // drop the grouping spaces
    if (next !== "" && !/^\d*\.?\d*$/.test(next)) return null;
    return next;
  }
  // Typing in a field makes it the active input (exact-in on pay, exact-out on
  // receive). Setting editSide here — not only on focus — guarantees the switch
  // even when focus doesn't fire first (programmatic input). The onFocus seed
  // below just pre-fills from the (≈) value for smooth continued editing.
  function onPayInput(e: React.ChangeEvent<HTMLInputElement>) {
    const next = cleanAmount(e.target.value);
    if (next === null) return;
    if (!payEditable) onEditSide("pay");
    onAmount(next);
  }
  function onRecvInput(e: React.ChangeEvent<HTMLInputElement>) {
    const next = cleanAmount(e.target.value);
    if (next === null) return;
    if (mode === "swap" && !recvEditable) onEditSide("receive");
    onAmount(next);
  }

  // ---- effective route (selected venue, else best) + amounts per side ----
  const outDecimals = tokenOut?.decimals ?? 18;
  const inDecimals = tokenIn?.decimals ?? 18;
  const route =
    mode === "swap" && quote
      ? quote.routes.find((r) => r.venue === selectedVenue) ?? quote.routes[0]
      : null;
  const bestVenue: string | null =
    mode === "swap"
      ? route?.venue ?? quote?.best.venue ?? selectedVenue
      : selectedVenue;

  // The (≈) value of a DERIVED side, ungrouped, for seeding the field when the
  // user focuses it to switch sides (so editing continues from what they saw).
  const payDerivedRaw =
    route ? fmtAmountOut(route.amountIn, inDecimals).replace(/[,\s]/g, "") : null;
  const recvDerivedRaw =
    route ? fmtAmountOut(route.amountOut, outDecimals).replace(/[,\s]/g, "") : null;

  // Focus-to-switch: focusing the inactive amount field flips the trade side and
  // seeds the amount with that field's current (≈) value. wrap/unwrap/send keep
  // the receive side read-only, so focusReceive is inert there.
  function focusPay() {
    if (payEditable) return; // already the input
    onEditSide("pay");
    onAmount(payDerivedRaw ?? "");
  }
  function focusReceive() {
    if (mode !== "swap" || recvEditable) return; // buy is swap-only / already input
    onEditSide("receive");
    onAmount(recvDerivedRaw ?? "");
  }

  // Displayed field values (grouped for readability; the input strips grouping
  // on change). The ACTIVE side shows the typed `amount`; the DERIVED side shows
  // the quote's (≈) value (or the synth 1:1 for wrap/unwrap).
  const payDisplayRaw = payEditable
    ? amount
    : route
      ? fmtAmountOut(route.amountIn, inDecimals)
      : "";
  let recvDisplayRaw = "";
  if (recvEditable) recvDisplayRaw = amount;
  else if (mode === "wrap" || mode === "unwrap")
    recvDisplayRaw = synthAmountOut ? fmtAmountOut(synthAmountOut, outDecimals) : "";
  else if (mode === "swap")
    recvDisplayRaw = route ? fmtAmountOut(route.amountOut, outDecimals) : "";
  const payDisplay = groupDigits(payDisplayRaw);
  const recvDisplay = groupDigits(recvDisplayRaw);
  // Spinner on the DERIVED side while the swap quote is still loading with no
  // route yet (the active/typed side never spins).
  const payLoading = !payEditable && mode === "swap" && quoteLoading && !route;
  const recvLoading = !recvEditable && mode === "swap" && quoteLoading && !route;

  // ---- USD values (per side, from the effective route / typed amount) ----
  const num = (s: string): number | null => {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Human amounts on each side: the fixed leg is the typed value, the variable
  // leg comes from the route.
  const payHuman = buyMode
    ? route
      ? toNumber(route.amountIn, inDecimals)
      : null
    : num(amount);
  const recvHuman = buyMode
    ? num(amount)
    : route
      ? toNumber(route.amountOut, outDecimals)
      : mode === "wrap" || mode === "unwrap"
        ? synthAmountOut
          ? toNumber(synthAmountOut, outDecimals)
          : null
        : null;
  const inUsd =
    payHuman != null && quote && quote.tokenInUsd !== null
      ? payHuman * quote.tokenInUsd
      : null;
  const outUsd =
    mode === "swap" && recvHuman != null && quote && quote.tokenOutUsd !== null
      ? recvHuman * quote.tokenOutUsd
      : null;

  // ---- rate, both directions (from the effective route, so it matches Via) ----
  const rates: string[] | null = (() => {
    if (mode === "wrap" || mode === "unwrap") return ["1:1 by construction"];
    if (mode !== "swap" || !quote || !tokenIn || !tokenOut || !route) return null;
    if (payHuman == null || recvHuman == null || payHuman <= 0 || recvHuman <= 0)
      return null;
    return [
      `1 ${tokenIn.symbol} = ${fmtRate(recvHuman / payHuman)} ${tokenOut.symbol}`,
      `1 ${tokenOut.symbol} = ${fmtRate(payHuman / recvHuman)} ${tokenIn.symbol}`,
    ];
  })();

  // ---- CoinGecko reference rate + deviation of the swap rate from it ----
  const cgRate = useCoingeckoRate(chain, tokenIn, tokenOut);
  const cgLine =
    mode === "swap" && cgRate && tokenIn && tokenOut
      ? `1 ${tokenIn.symbol} = ${fmtRate(cgRate)} ${tokenOut.symbol}`
      : null;
  const cgDiffPct = (() => {
    if (mode !== "swap" || !cgRate || !quote || !tokenIn || !tokenOut || !route) return null;
    if (payHuman == null || recvHuman == null || payHuman <= 0) return null;
    const swapRate = recvHuman / payHuman;
    if (!Number.isFinite(swapRate) || swapRate <= 0) return null;
    return (swapRate / cgRate - 1) * 100;
  })();
  // Gate the Swap button when the route executes strictly worse than -10% vs the
  // CoinGecko mid. cgDiffPct is already null outside swap mode and whenever
  // CoinGecko is unavailable, so a null value (no reference rate) never gates —
  // same behaviour as before the gate existed. Threshold hardcoded per spec.
  const needsRateConfirm = mode === "swap" && cgDiffPct !== null && cgDiffPct < -10;

  // ---- recipient validity (send) ----
  const recipientValid = !isSend || ADDRESS_RE.test(recipient.trim());

  // ---- action button state ----
  // hasAmount checks the ACTIVE side's amount (tokenIn on sell, tokenOut on buy).
  const activeToken = buyMode ? tokenOut : tokenIn;
  const hasAmount = !!activeToken && !!toBaseUnits(amount, activeToken.decimals);
  const pairReady = !!tokenIn && (isSend || !!tokenOut);
  const canAct =
    connected &&
    pairReady &&
    hasAmount &&
    recipientValid &&
    (mode === "send" || mode === "wrap" || mode === "unwrap" || !!quote) &&
    !quoteLoading &&
    !actionBusy;

  // Button label cascade. Orchestrator can override via actionLabel (e.g.
  // "Approve WETH", "Confirm in wallet…").
  const buttonLabel = (() => {
    if (!connected) return "Connect Wallet";
    if (actionLabel) return actionLabel;
    if (!pairReady) return "Select tokens";
    if (!hasAmount) return "Enter an amount";
    if (isSend && !recipientValid) return "Enter a recipient";
    if (mode === "swap" && quoteLoading) return "Fetching quote…";
    if (mode === "swap" && !quote) return quoteError ? "No route" : "Enter an amount";
    return `${copy.verb}${mode === "send" ? "" : mode === "swap" ? "" : ""}`;
  })();

  // Equivalent `swap …` line for the current form (copy button to the right of
  // the primary action). null while amount/tokens are too incomplete.
  const allVenueNames = venues.map((v) => v.name);
  const cliCmd = buildCliCommand({
    chain,
    tokenIn,
    tokenOut,
    amount,
    editSide,
    mode,
    isSend,
    recipient,
    slippageBps,
    allowAsync,
    enabledVenues,
    allVenueNames,
    fromAddress: senderAddress,
    json: cliJson,
    data: cliData,
    simu: cliSimu,
  });
  const [cliCopied, setCliCopied] = React.useState(false);
  // Hover tip on the terminal button ("click to copy CLI command"). Hidden
  // while the success toast is up so the two bubbles never stack.
  const [cliHover, setCliHover] = React.useState(false);
  const cliTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (cliTimer.current) clearTimeout(cliTimer.current);
    };
  }, []);
  async function copyCli() {
    if (!cliCmd) return;
    const ok = await copyText(cliCmd);
    if (!ok) return;
    setCliCopied(true);
    setCliHover(false);
    if (cliTimer.current) clearTimeout(cliTimer.current);
    // Slightly longer than the footer flash so the bubble can be read.
    cliTimer.current = setTimeout(() => setCliCopied(false), 2200);
  }

  return (
    <div style={d.card}>
      {/* head: mode tabs + settings */}
      <div style={d.cardHead}>
        <div style={d.tabs} role="tablist" aria-label="Action">
          <button
            type="button"
            role="tab"
            aria-selected={!isSend}
            onClick={() => onIsSend(false)}
            style={{ ...d.tab, ...(!isSend ? d.tabOn : null) }}
          >
            Swap
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isSend}
            onClick={() => onIsSend(true)}
            style={{ ...d.tab, ...(isSend ? d.tabOn : null) }}
          >
            Send
          </button>
        </div>
        <SettingsPopover
          venues={venues}
          enabledVenues={enabledVenues}
          onToggleVenue={onToggleVenue}
          onSetAllVenues={onSetAllVenues}
          allowAsync={allowAsync}
          cliJson={cliJson}
          onCliJson={onCliJson}
          cliData={cliData}
          onCliData={onCliData}
          cliSimu={cliSimu}
          onCliSimu={onCliSimu}
          chain={chain}
        />
      </div>

      {/* token flow */}
      <div style={{ position: "relative" }}>
        {/* You pay */}
        <div style={d.tokenCard}>
          <div style={d.tokenLabelRow}>
            <span style={d.tokenLabel}>{payLabel}</span>
            {/* Balance readout — a MAX button while the pay side is the input
                (exact-in); a plain readout while pay shows a derived (≈) value
                (exact-out), where MAX is meaningless (PR7 §dApp #4). */}
            {inBalance !== null &&
              (payEditable ? (
                <button type="button" style={d.balBtn} onClick={setMax}>
                  <span style={d.balText}>
                    Balance {inBalance} {tokenIn?.symbol}
                  </span>
                  <span style={d.maxTag}>MAX</span>
                </button>
              ) : (
                <span style={d.balText}>
                  Balance {inBalance} {tokenIn?.symbol}
                </span>
              ))}
          </div>
          <AmountField
            value={payDisplay}
            derived={!payEditable}
            loading={payLoading}
            readOnly={false}
            onChange={onPayInput}
            onFocus={focusPay}
            token={tokenIn}
            chainId={chain.chainId}
            onPickToken={onPickIn}
            ariaLabel="Amount to pay"
          />
          <div style={d.usdLine}>{inUsd !== null ? `≈ ${formatUsd(inUsd)}` : " "}</div>
          {showSlider && (
            <AmountSlider pct={amountPct} onPct={(p) => setAmountFraction(p / 100)} />
          )}
        </div>

        {/* flip */}
        <div style={d.flowArrow}>
          <button
            type="button"
            aria-label="Flip tokens"
            onClick={onFlip}
            style={d.flowArrowInner}
            disabled={isSend}
          >
            <Icon name="swap" size={16} style={{ color: "var(--text-strong)" }} />
          </button>
        </div>

        {/* You receive / To */}
        <div style={{ ...d.tokenCard, background: "var(--ink-900)" }}>
          <span style={d.tokenLabel}>{recvLabel}</span>
          {isSend ? (
            <div style={{ marginTop: 12 }}>
              <Input
                value={recipient}
                onChange={(e) => onRecipient(e.target.value)}
                placeholder="0x recipient address"
                mono
                invalid={recipient.trim() !== "" && !recipientValid}
                prefix={<Icon name="wallet" size={15} />}
              />
              {recipient.trim() !== "" && !recipientValid && (
                <p style={d.recipientWarn}>
                  <Icon name="alert" size={12} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                  Not a valid 20-byte address.
                </p>
              )}
            </div>
          ) : (
            <>
              <AmountField
                value={recvDisplay}
                derived={!recvEditable}
                loading={recvLoading}
                readOnly={mode !== "swap"}
                onChange={onRecvInput}
                onFocus={focusReceive}
                token={tokenOut}
                chainId={chain.chainId}
                onPickToken={onPickOut}
                ariaLabel="Amount to receive"
              />
              <div style={d.usdLine}>
                {outUsd !== null ? `≈ ${formatUsd(outUsd)}` : " "}
              </div>
            </>
          )}
        </div>
      </div>

      {/* quote error (swap mode) */}
      {mode === "swap" && quoteError && !quoteLoading && (
        <div style={d.errBox}>
          <Icon name="alert" size={14} style={{ color: "var(--negative)" }} />
          <span>No route found for this pair.</span>
        </div>
      )}

      {/* summary */}
      <Summary
        mode={mode}
        venue={bestVenue}
        slippageBps={slippageBps}
        onSlippageBps={onSlippageBps}
        rates={rates}
        cgLine={cgLine}
        cgDiffPct={cgDiffPct}
      />

      {/* action + copy-CLI (CLI button sits to the right of Swap/Send/Connect) */}
      <div style={d.actionRow}>
        {!connected ? (
          <Button
            variant="primary"
            size="lg"
            fullWidth
            leftIcon={<Icon name="wallet" size={17} />}
            onClick={onConnect}
            style={{ flex: 1, minWidth: 0 }}
          >
            Connect Wallet
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            fullWidth
            href={actionHref}
            disabled={!actionHref && (!canAct || actionDone)}
            loading={!actionHref && actionBusy}
            rightIcon={
              actionHref ? <Icon name="external" size={17} /> : undefined
            }
            // Bad-rate gate stands in front of onAction: a sub-(-10)% route opens
            // the confirm modal first; otherwise the normal build flow runs.
            onClick={
              actionHref
                ? undefined
                : () => (needsRateConfirm ? setRateConfirmOpen(true) : onAction())
            }
            style={{ flex: 1, minWidth: 0 }}
          >
            {buttonLabel}
          </Button>
        )}
        <div
          style={d.cliWrap}
          onMouseEnter={() => setCliHover(true)}
          onMouseLeave={() => setCliHover(false)}
          onFocus={() => setCliHover(true)}
          onBlur={() => setCliHover(false)}
        >
          <style>{CLI_TOAST_CSS}</style>
          {/* Hover tip: explains what the terminal button does. Success toast
              takes over after a click so the two never stack. */}
          {cliHover && !cliCopied && (
            <div style={d.cliTip} role="tooltip">
              <Icon name="terminal" size={12} style={{ color: "var(--text-link)", flex: "none" }} />
              <span>
                {cliCmd
                  ? "Click to copy the CLI command"
                  : "Fill amount & tokens to copy the CLI command"}
              </span>
            </div>
          )}
          {/* Ephemeral "copied" bubble — sits above the button, auto-hides. */}
          {cliCopied && (
            <div
              style={d.cliToast}
              role="status"
              aria-live="polite"
            >
              <Icon name="check" size={13} style={{ color: "var(--positive)", flex: "none" }} />
              <span>
                CLI command copied
                <span style={d.cliToastSub}> to clipboard</span>
              </span>
            </div>
          )}
          <button
            type="button"
            style={{
              ...d.cliBtn,
              ...(cliCmd ? null : d.cliBtnDisabled),
              ...(cliCopied ? d.cliBtnCopied : null),
            }}
            disabled={!cliCmd}
            onClick={copyCli}
            // Native title suppressed — the custom bubble is the hover UI.
            title={undefined}
            aria-label={
              cliCopied
                ? "CLI command copied to clipboard"
                : cliCmd
                  ? `Copy CLI command: ${cliCmd}`
                  : "Copy CLI command (fill amount and tokens first)"
            }
          >
            {cliCopied ? (
              <Icon name="check" size={18} style={{ color: "var(--positive)" }} />
            ) : (
              <Icon name="terminal" size={18} />
            )}
          </button>
        </div>
      </div>

      {/* Bad-rate confirm gate. Rendered ONLY while open so <BadRateModal>'s
          typed text starts empty each time — a fresh sub-(-10)% quote after a
          Cancel must be re-confirmed. diffPct is passed LIVE (it may move, or go
          null if CoinGecko drops out, while the modal is open); the modal keeps
          gating either way. */}
      {rateConfirmOpen && (
        <BadRateModal
          diffPct={cgDiffPct}
          pairLabel={tokenIn && tokenOut ? `${tokenIn.symbol} → ${tokenOut.symbol}` : ""}
          venueLabel={bestVenue ? vmeta(bestVenue).label : null}
          onCancel={() => setRateConfirmOpen(false)}
          onConfirm={() => {
            setRateConfirmOpen(false);
            onAction();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ bad-rate gate ----------------------------- */
// Type-to-confirm modal shown when the selected route executes strictly worse
// than -10% vs the CoinGecko mid. It sits between the primary Swap click and any
// build/wallet prompt: the user must type exactly "confirm" (case-sensitive,
// untrimmed) to unlock Continue. The parent renders it conditionally, so the
// `text` state below resets on every open — there is no persistent "confirmed"
// flag; every Swap click re-evaluates and re-gates. Overlay mirrors
// <TokenSelector> (click-outside closes, inner panel stops propagation).
function BadRateModal({
  diffPct,
  pairLabel,
  venueLabel,
  onCancel,
  onConfirm,
}: {
  // LIVE deviation of the swap rate from the CoinGecko mid (negative = worse).
  // May turn null if CoinGecko drops out while the modal is open — the gate
  // stays up (rendered as "–"), it just can't show the number.
  diffPct: number | null;
  pairLabel: string;
  venueLabel: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Exact string match: case-sensitive, NOT trimmed. "Confirm", "CONFIRM",
  // " confirm" all stay locked; only the literal "confirm" unlocks Continue.
  const [text, setText] = React.useState("");
  const unlocked = text === "confirm";
  return (
    <div style={d.gateOverlay} onClick={onCancel}>
      <div
        style={d.gatePanel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm a bad swap rate"
      >
        <div style={d.gateHead}>
          <Icon name="alert" size={18} style={{ color: "var(--negative)", flex: "none" }} />
          <span style={d.gateTitle}>Rate far below market</span>
        </div>
        {/* The live deviation, coloured exactly like the Summary CoinGecko row. */}
        <p style={d.gateBody}>
          This route{venueLabel ? ` via ${venueLabel}` : ""} executes{" "}
          <span
            style={{
              color: diffPct != null ? cgDiffColor(diffPct) : "var(--text-tertiary)",
              fontWeight: 700,
            }}
          >
            {diffPct != null ? `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(2)}%` : "–"}
          </span>{" "}
          vs the CoinGecko mid{pairLabel ? ` for ${pairLabel}` : ""}. That is a large
          loss — proceed only if you understand why.
        </p>
        <p style={d.gateInstruct}>
          Type <span style={d.gateWord}>confirm</span> to continue.
        </p>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits only once the exact word is typed.
            if (e.key === "Enter" && unlocked) onConfirm();
          }}
          placeholder="confirm"
          aria-label="Type confirm to proceed"
          mono
          autoFocus
        />
        <div style={d.gateActions}>
          <Button variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="md" disabled={!unlocked} onClick={onConfirm}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- amount field ----------------------------- */
// One editable amount side (pay or receive) + its token pill. Both sides are
// real inputs so the user can type into either to switch the trade direction
// (focus flips exact-in ↔ exact-out via onFocus). The `derived` side shows the
// quote's (≈) value muted; the active side shows the typed amount in strong ink.
// A spinner rides next to the derived side while its quote is still loading.
function AmountField({
  value,
  derived,
  loading,
  readOnly,
  onChange,
  onFocus,
  token,
  chainId,
  onPickToken,
  ariaLabel,
}: {
  value: string;
  derived: boolean;
  loading: boolean;
  readOnly: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  token: TokenInfo | null;
  // Scopes the icon fallback CDNs (TrustWallet is per-chain).
  chainId: number;
  onPickToken: () => void;
  ariaLabel: string;
}) {
  return (
    <div style={d.tokenMid}>
      <input
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        readOnly={readOnly}
        inputMode="decimal"
        placeholder="0.0"
        aria-label={ariaLabel}
        style={{
          ...d.amountInput,
          color: derived ? "var(--text-secondary)" : "var(--text-strong)",
          ...(readOnly ? { cursor: "default" } : null),
        }}
      />
      {loading && (
        <Icon
          name="spinner"
          size={18}
          style={{ color: "var(--text-tertiary)", flex: "none" }}
        />
      )}
      <TokenPill token={token} chainId={chainId} onClick={onPickToken} />
    </div>
  );
}

/* -------------------------------- token pill ------------------------------ */
function TokenPill({
  token,
  chainId,
  onClick,
}: {
  token: TokenInfo | null;
  // Scopes the icon fallback CDNs (TrustWallet is per-chain).
  chainId: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={d.tokenPill}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-frost-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface-elevated)")}
    >
      {token ? (
        <>
          <TokenIcon token={token} chainId={chainId} bare size="md" />
          <span style={d.tokenSym}>{token.symbol}</span>
        </>
      ) : (
        <span style={{ ...d.tokenSym, color: "var(--text-secondary)" }}>Select</span>
      )}
      <Icon name="chevron" size={15} style={{ color: "var(--text-tertiary)" }} />
    </button>
  );
}

/* ------------------------------- amount slider ---------------------------- */
// Native range input for hit-testing + keyboard, with a CUSTOM track underneath.
// Browser range thumbs travel inset by half their width (center at 0% sits at
// 7.5px, at 100% at width−7.5px). Painting the track full-width left a stub of
// line past the knob at 100%. The visual track is inset to match the thumb
// path, so at 0%/100% the line ends under the knob center — truly "at the end".
const THUMB_PX = 15;
const THUMB_R = THUMB_PX / 2;
const SLIDER_CSS = `
.swagg-amt-range{-webkit-appearance:none;appearance:none;position:relative;z-index:2;width:100%;height:${THUMB_PX}px;border-radius:999px;outline:none;cursor:pointer;margin:0;padding:0;background:transparent;}
/* Track same height as the input so the thumb stays vertically centered; paint is on the inset div underneath. */
.swagg-amt-range::-webkit-slider-runnable-track{height:${THUMB_PX}px;border-radius:999px;background:transparent;}
.swagg-amt-range::-moz-range-track{height:${THUMB_PX}px;border-radius:999px;background:transparent;border:none;}
.swagg-amt-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:${THUMB_PX}px;height:${THUMB_PX}px;margin-top:0;border-radius:50%;background:var(--brand-solid);border:2px solid var(--surface-raised);box-shadow:0 1px 3px rgba(0,0,0,.45);cursor:pointer;box-sizing:border-box;}
.swagg-amt-range::-moz-range-thumb{width:${THUMB_PX}px;height:${THUMB_PX}px;border:2px solid var(--surface-raised);border-radius:50%;background:var(--brand-solid);box-shadow:0 1px 3px rgba(0,0,0,.45);cursor:pointer;box-sizing:border-box;}
.swagg-amt-range:focus-visible{box-shadow:none;}
`;

function AmountSlider({ pct, onPct }: { pct: number; onPct: (p: number) => void }) {
  const p = Math.max(0, Math.min(100, pct));
  // Show a "%" bubble over the thumb while the user is dragging / focusing it.
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    if (!active) return;
    const end = () => setActive(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [active]);
  // Thumb center = THUMB_R + p% × (width − THUMB_PX). Same math for bubble + fill.
  const thumbPos = `calc(${THUMB_R}px + (100% - ${THUMB_PX}px) * ${p / 100})`;
  return (
    <div style={d.sliderWrap}>
      <style>{SLIDER_CSS}</style>
      <div
        style={{ ...d.sliderBubble, left: thumbPos, opacity: active ? 1 : 0 }}
        aria-hidden="true"
      >
        {Math.round(p)}%
      </div>
      {/* Inset track: ends under the thumb center at 0% and 100% (no stub past the knob). */}
      <div style={d.sliderTrack} aria-hidden="true">
        <div style={{ ...d.sliderFill, width: `${p}%` }} />
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(p)}
        onChange={(e) => onPct(Number(e.target.value))}
        onPointerDown={() => setActive(true)}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        className="swagg-amt-range"
        aria-label="Amount as percent of balance"
      />
      <div style={d.sliderTicks} aria-hidden="true">
        {[25, 50, 75].map((t) => (
          <span
            key={t}
            style={{
              ...d.sliderTick,
              // Ticks share the inset coordinate system of the track.
              left: `calc(${THUMB_R}px + (100% - ${THUMB_PX}px) * ${t / 100})`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- summary -------------------------------- */
// Group the integer part in 3-digit clusters with a space so big amounts stay
// readable ("1 000 000"). Strips any existing separators (commas from
// formatUnits) first, leaves the fractional part and partial input intact.
function groupDigits(s: string): string {
  if (!s) return s;
  const dot = s.indexOf(".");
  const intRaw = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? undefined : s.slice(dot + 1);
  const int = intRaw.replace(/[^\d]/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return frac !== undefined ? `${int}.${frac}` : int;
}

// Receive-amount precision: fewer decimals as the number grows, so big amounts
// fit the box without an ellipsis (6 decimals on millions is pointless precision).
function fmtAmountOut(raw: string, decimals: number): string {
  const n = toNumber(raw, decimals);
  const frac = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return formatUnits(raw, decimals, frac);
}

// Format a unit rate: 6 decimals for normal magnitudes, 4 significant digits
// below 0.001 so tiny inverse rates don't collapse to "0".
function fmtRate(x: number): string {
  return x >= 0.001
    ? x.toLocaleString("en-US", { maximumFractionDigits: 6 })
    : x.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

function Summary({
  mode,
  venue,
  slippageBps,
  onSlippageBps,
  rates,
  cgLine,
  cgDiffPct,
}: {
  mode: FormMode;
  venue: string | null;
  slippageBps: number;
  onSlippageBps: (bps: number) => void;
  rates: string[] | null;
  cgLine: string | null;
  cgDiffPct: number | null;
}) {
  // Nothing to show for send mode (no rate, no venue, no slippage).
  if (mode === "send") return null;
  const isSwap = mode === "swap";
  // In swap mode every row is rendered UNCONDITIONALLY (placeholder when its data
  // isn't in yet) so the panel's row count — and thus its height — stays constant
  // across the quote lifecycle. The CoinGecko row arrives async (independent of
  // the quote stream) and the rate/diff lines depend on the quote, so without
  // this the panel grows/shrinks on every fetch and the Swap button below jumps.
  const NBSP = " "; // invisible placeholder that still reserves line height
  return (
    <div style={d.summary}>
      {isSwap && (
        <Row k="CoinGecko">
          <span style={d.stack2}>
            <span>{cgLine ?? "—"}</span>
            <span
              style={{
                color: cgDiffPct != null ? cgDiffColor(cgDiffPct) : "transparent",
                fontWeight: 600,
              }}
            >
              {cgDiffPct != null
                ? `${cgDiffPct >= 0 ? "+" : ""}${cgDiffPct.toFixed(2)}% vs CoinGecko`
                : NBSP}
            </span>
          </span>
        </Row>
      )}
      <Row k="Rate">
        <span style={d.stack2}>
          <span>{rates?.[0] ?? "—"}</span>
          {isSwap && (
            <span style={{ color: "var(--text-tertiary)" }}>{rates?.[1] ?? NBSP}</span>
          )}
        </span>
      </Row>
      {isSwap && (
        <Row k="Via">
          <span style={{ color: venue ? "var(--text-link)" : "var(--text-tertiary)" }}>
            {venue ? vmeta(venue).label : "—"}
          </span>
        </Row>
      )}
      {isSwap && (
        <div style={d.sumRow} data-slip-row>
          <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>
            Max slippage (%)
          </span>
          <SlippageField slippageBps={slippageBps} onSlippageBps={onSlippageBps} />
        </div>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={d.sumRow}>
      <span style={{ color: "var(--text-tertiary)", fontSize: 13 }}>{k}</span>
      <span style={d.sumV} data-sum-v>{children}</span>
    </div>
  );
}

// Max-slippage control for the summary row: a sober segmented pill group with
// the four common tolerances (0.02% / 0.1% / 0.5% / 1%) plus a small custom
// percent input. Canonical value lives in slippageBps (1 bp = 0.01%); the
// custom field keeps a local text mirror so typing "0." / "" doesn't stomp the
// caret. Clamps to [0, 5000] bps (0%–50%).
const SLIPPAGE_CHOICES_BPS = [2, 10, 50, 100] as const; // 0.02% / 0.1% / 0.5% / 1%

function SlippageField({
  slippageBps,
  onSlippageBps,
}: {
  slippageBps: number;
  onSlippageBps: (bps: number) => void;
}) {
  const isPreset = (SLIPPAGE_CHOICES_BPS as readonly number[]).includes(
    slippageBps,
  );
  // Trimmed percent string for the current bps (e.g. 10 → "0.1", 100 → "1").
  const pctStr = String(Number((slippageBps / 100).toFixed(2)));
  // Custom field text: empty while a preset is active, the canonical percent
  // otherwise. Re-seeded from the canonical bps only when not focused.
  const [text, setText] = React.useState(isPreset ? "" : pctStr);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(isPreset ? "" : pctStr);
  }, [pctStr, isPreset, focused]);

  function onCustomChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    if (next !== "" && !/^\d*\.?\d*$/.test(next)) return;
    setText(next);
    const pct = Number(next.trim());
    if (next.trim() !== "" && Number.isFinite(pct) && pct >= 0) {
      onSlippageBps(Math.min(Math.round(pct * 100), 5000));
    }
  }

  return (
    <span style={d.slipGroup} role="group" aria-label="Max slippage">
      {SLIPPAGE_CHOICES_BPS.map((bps) => {
        const active = slippageBps === bps;
        return (
          <button
            key={bps}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setText("");
              onSlippageBps(bps);
            }}
            style={{ ...d.slipSeg, ...(active ? d.slipSegOn : null) }}
          >
            {String(Number((bps / 100).toFixed(2)))}
          </button>
        );
      })}
      <input
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={onCustomChange}
        inputMode="decimal"
        placeholder="custom"
        aria-label="Custom max slippage percent"
        style={{
          ...d.slipCustom,
          ...(!isPreset ? d.slipSegOn : null),
          ...(slippageBps === 0 && !isPreset
            ? { boxShadow: "inset 0 0 0 1px var(--warning)" }
            : null),
        }}
      />
    </span>
  );
}

/* --------------------------------- styles --------------------------------- */
// Fade + slight rise for the "CLI command copied" bubble above the terminal btn.
const CLI_TOAST_CSS = `@keyframes swaggCliToastIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`;

const d: Record<string, React.CSSProperties> = {
  card: {
    position: "relative",
    background: "var(--surface-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-md), var(--shadow-inset)",
    padding: 20,
    alignSelf: "start",
  },
  actionRow: {
    marginTop: 16,
    display: "flex",
    alignItems: "stretch",
    gap: 10,
  },
  // Anchor for the copy button + floating "copied" toast above it.
  cliWrap: {
    position: "relative",
    flex: "none",
    alignSelf: "stretch",
    display: "flex",
    alignItems: "stretch",
  },
  // Square sibling of the primary action — copies the equivalent `swap …` line.
  cliBtn: {
    flex: "none",
    width: 52,
    height: 52,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-elevated)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: 0,
    transition:
      "background var(--dur-base, 150ms) ease, border-color var(--dur-base, 150ms) ease, color var(--dur-base, 150ms) ease",
  },
  cliBtnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  cliBtnCopied: {
    borderColor: "var(--positive-dim, rgba(47,227,154,0.45))",
    background: "var(--positive-bg, rgba(47,227,154,0.12))",
  },
  // Hover tip above the terminal button ("click to copy…").
  cliTip: {
    position: "absolute",
    bottom: "calc(100% + 10px)",
    right: 0,
    zIndex: 5,
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid var(--border-default)",
    background: "var(--ink-850, #16131f)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    animation: "swaggCliToastIn 140ms ease-out",
  },
  // Small floating bubble above the terminal button after a successful copy.
  cliToast: {
    position: "absolute",
    bottom: "calc(100% + 10px)",
    right: 0,
    zIndex: 5,
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid var(--positive-dim, rgba(47,227,154,0.4))",
    background: "var(--ink-850, #16131f)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(47,227,154,0.08)",
    color: "var(--text-primary)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    animation: "swaggCliToastIn 160ms ease-out",
  },
  cliToastSub: {
    color: "var(--text-tertiary)",
    fontWeight: 500,
  },
  cardHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },

  tabs: {
    display: "inline-flex",
    gap: 2,
    padding: 3,
    background: "var(--surface-frost)",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border-subtle)",
  },
  tab: {
    padding: "6px 16px",
    border: "none",
    borderRadius: "var(--radius-pill)",
    background: "transparent",
    color: "var(--text-secondary)",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out)",
  },
  tabOn: {
    background: "var(--gradient-brand)",
    color: "var(--text-on-brand)",
  },

  tokenCard: {
    background: "var(--surface-input)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    padding: "14px 16px",
  },
  tokenLabelRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  tokenLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--text-tertiary)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  balBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: 0,
  },
  balText: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-tertiary)",
    fontFeatureSettings: '"tnum" 1',
  },
  maxTag: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.06em",
    color: "var(--brand-solid)",
    padding: "2px 7px",
    borderRadius: "var(--radius-pill)",
    background: "var(--brand-soft)",
    border: "1px solid var(--border-brand)",
  },
  tokenMid: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginTop: 8,
  },
  amountInput: {
    flex: 1,
    minWidth: 0,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-strong)",
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    fontSize: 30,
    letterSpacing: "-0.02em",
    fontFeatureSettings: '"tnum" 1',
    lineHeight: 1,
    padding: 0,
    // Round the global :focus-visible ring (box-shadow follows border-radius)
    // so the focus outline isn't a sharp rectangle.
    borderRadius: "var(--radius-md)",
  },
  sliderWrap: {
    position: "relative",
    marginTop: 12,
    // Clearance so the slider/thumb clears the flip button, which is anchored
    // to this card's bottom edge (top:-17 on flowArrowInner) and would otherwise
    // sit on the slider track.
    marginBottom: 14,
    display: "flex",
    alignItems: "center",
    height: THUMB_PX,
  },
  // Grey rail inset by half-thumb so 0%/100% line up with the native thumb path.
  sliderTrack: {
    position: "absolute",
    left: THUMB_R,
    right: THUMB_R,
    top: "50%",
    height: 5,
    transform: "translateY(-50%)",
    borderRadius: 999,
    background: "var(--border-default)",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: 0,
  },
  sliderFill: {
    height: "100%",
    borderRadius: 999,
    background: "var(--brand-solid)",
  },
  sliderBubble: {
    position: "absolute",
    top: -4,
    transform: "translate(-50%, -100%)",
    padding: "2px 7px",
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-pill)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-strong)",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 3,
    boxShadow: "var(--shadow-sm)",
    transition: "opacity var(--dur-fast) var(--ease-out)",
  },
  sliderTicks: {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    height: 0,
    transform: "translateY(-50%)",
    pointerEvents: "none",
    zIndex: 1,
  },
  sliderTick: {
    position: "absolute",
    top: 0,
    width: 3,
    height: 3,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.3)",
    transform: "translate(-50%, -50%)",
  },
  usdLine: {
    marginTop: 8,
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-tertiary)",
    fontFeatureSettings: '"tnum" 1',
    minHeight: 15,
  },
  tokenPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-pill)",
    padding: "7px 10px 7px 8px",
    flex: "none",
    cursor: "pointer",
    transition: "background var(--dur-base) var(--ease-out)",
  },
  tokenSym: { fontWeight: 700, fontSize: 16, color: "var(--text-strong)" },

  flowArrow: {
    display: "flex",
    justifyContent: "center",
    height: 0,
    position: "relative",
    zIndex: 2,
  },
  flowArrowInner: {
    position: "absolute",
    top: -17,
    display: "inline-flex",
    padding: 9,
    background: "var(--surface-card)",
    border: "3px solid var(--surface-card)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-sm)",
    cursor: "pointer",
  },

  errBox: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    padding: "10px 12px",
    background: "var(--negative-bg)",
    border: "1px solid rgba(255,92,108,0.4)",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    color: "var(--text-secondary)",
  },

  recipientWarn: {
    margin: "6px 0 0",
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--warning)",
  },

  summary: {
    marginTop: 16,
    padding: "12px 14px",
    background: "var(--surface-frost)",
    borderRadius: "var(--radius-lg)",
    display: "flex",
    flexDirection: "column",
    gap: 9,
  },
  sumRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    whiteSpace: "nowrap",
  },
  sumV: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
    fontFeatureSettings: '"tnum" 1',
    textAlign: "right",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "60%",
  },
  // Two-line right-aligned value (CoinGecko rate + diff, Rate + inverse). Both
  // lines always present so the row height is constant — see <Summary>.
  stack2: {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 3,
  },

  // Bad-rate confirm gate — overlay mirrors <TokenSelector>'s (fixed, blurred,
  // centered); the panel is a narrower version of that modal.
  gateOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    background: "var(--surface-overlay)",
    backdropFilter: "blur(4px)",
    WebkitBackdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  gatePanel: {
    width: 400,
    maxWidth: "92vw",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    background: "var(--surface-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius-2xl)",
    boxShadow: "var(--shadow-xl)",
    padding: 22,
  },
  gateHead: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  gateTitle: {
    fontFamily: "var(--font-display)",
    fontWeight: 600,
    fontSize: 18,
    color: "var(--text-strong)",
  },
  gateBody: {
    margin: 0,
    fontSize: 13.5,
    lineHeight: 1.55,
    color: "var(--text-secondary)",
  },
  gateInstruct: {
    margin: 0,
    fontSize: 13,
    color: "var(--text-tertiary)",
  },
  gateWord: {
    fontFamily: "var(--font-mono)",
    fontWeight: 700,
    color: "var(--text-strong)",
  },
  gateActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 2,
  },
  slipGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: 3,
    background: "var(--surface-input)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-pill)",
  },
  slipSeg: {
    border: "none",
    background: "transparent",
    color: "var(--text-tertiary)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 600,
    fontFeatureSettings: '"tnum" 1',
    lineHeight: 1.2,
    padding: "5px 10px",
    borderRadius: "var(--radius-pill)",
    cursor: "pointer",
    transition:
      "background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out)",
  },
  slipSegOn: {
    background: "var(--brand-soft)",
    color: "var(--text-strong)",
    boxShadow: "inset 0 0 0 1px var(--border-brand)",
  },
  slipCustom: {
    // Wide enough for the 6-char "custom" placeholder in mono at any platform's
    // glyph metrics (the binary embeds its own font stack); narrow padding keeps
    // the content box generous so nothing clips to "custo".
    width: 76,
    boxSizing: "border-box",
    textAlign: "center",
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-strong)",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    fontWeight: 600,
    fontFeatureSettings: '"tnum" 1',
    lineHeight: 1.2,
    padding: "5px 4px",
    borderRadius: "var(--radius-pill)",
  },
};

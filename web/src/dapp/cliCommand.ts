// Build a `swap …` CLI invocation that mirrors the interactive dApp form
// state. Pure, side-effect-free — the UI just copies the resulting string.
//
// Flags mostly mirror CLI defaults in src/index.ts so we only emit
// non-default ones (chain eth, venue all, allow-async off, action swap).
// Slippage is always emitted so the copied line matches the UI slider.
// Copy-CLI extras (--json / -d / --simu) follow Settings, not CLI defaults:
// `-d` is on by default in the dApp copy (CLI itself defaults off).

import type { ChainMeta, TokenInfo } from "./types";
import type { FormMode, EditSide } from "./useQuote";

export type CliCommandInput = {
  chain: ChainMeta;
  tokenIn: TokenInfo | null;
  tokenOut: TokenInfo | null;
  amount: string;
  editSide: EditSide;
  mode: FormMode;
  isSend: boolean;
  recipient: string;
  slippageBps: number;
  allowAsync: boolean;
  /** Venues left enabled in Settings. Empty / full set ⇒ omit -v (CLI default all). */
  enabledVenues: string[];
  allVenueNames: string[];
  /** Connected wallet → CLI `--from 0x…` (sender for -d / balances / simulate). */
  fromAddress?: string | null;
  /** Settings → Copy CLI. `--json` is valid for send too. */
  json?: boolean;
  /** Settings → Copy CLI. Default on. Forced on when `simu` is set. */
  data?: boolean;
  /** Settings → Copy CLI. Implies `-d` (simulate needs a built tx). */
  simu?: boolean;
};

const DEFAULT_CHAIN = "eth";

// Token symbols that are safe unquoted shell tokens (CLI accepts symbol or 0x).
const SAFE_SYMBOL = /^[A-Za-z][A-Za-z0-9.]*$/;

function tokenArg(t: TokenInfo): string {
  if (SAFE_SYMBOL.test(t.symbol)) return t.symbol;
  return t.address;
}

/** Human amount as typed in the form (strip grouping spaces/commas). */
function cleanAmount(amount: string): string {
  return amount.replace(/[\s,]/g, "").trim();
}

/**
 * Returns the equivalent `swap …` command, or `null` when the form is too
 * incomplete to produce a useful line (no amount / missing tokens).
 */
export function buildCliCommand(input: CliCommandInput): string | null {
  const amount = cleanAmount(input.amount);
  if (!amount || !/^\d*\.?\d+$/.test(amount) || amount === ".") return null;
  if (!input.tokenIn) return null;

  const isSend = input.isSend || input.mode === "send";
  const parts: string[] = ["swap", amount, tokenArg(input.tokenIn)];

  if (isSend) {
    // `swap <amount> <tokenIn> -a send --to 0x…` — tokenOut is ignored.
    parts.push("-a", "send");
    const to = input.recipient.trim();
    if (/^0x[a-fA-F0-9]{40}$/.test(to)) {
      parts.push("--to", to);
    }
  } else {
    if (!input.tokenOut) return null;
    parts.push(tokenArg(input.tokenOut));
  }

  if (input.chain.alias !== DEFAULT_CHAIN) {
    parts.push("-c", input.chain.alias);
  }

  // Sender: emit when the dApp has a connected wallet (checksum casing preserved
  // as received; CLI accepts any EIP-55 / lower case).
  const from = (input.fromAddress ?? "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(from)) {
    parts.push("--from", from);
  }

  // Venue / slippage / async flags only apply to real swaps (and
  // wrap/unwrap, which share the same CLI shape — wrap is auto-detected).
  if (!isSend) {
    // Venue filter: only emit -v when the Settings multi-select is a proper
    // subset. All-on (or empty) ⇒ CLI default `all` (comparison + best route).
    const allOn =
      input.enabledVenues.length === 0 ||
      input.enabledVenues.length === input.allVenueNames.length ||
      (input.allVenueNames.length > 0 &&
        input.allVenueNames.every((v) => input.enabledVenues.includes(v)));

    if (!allOn && input.enabledVenues.length > 0) {
      parts.push("-v", input.enabledVenues.join(","));
    }

    // Always include --slippage so the copied CLI matches the UI value
    // (CLI --slippage is percent: 0.1 = 0.1%, 1 = 1%; form stores bps).
    {
      const pct = Math.max(0, input.slippageBps) / 100;
      const pctStr = String(Number(pct.toFixed(4)));
      parts.push("--slippage", pctStr);
    }

    // Exact-out (buy): only meaningful in swap mode with the receive side active.
    if (input.mode === "swap" && input.editSide === "receive") {
      parts.push("--exact-out");
    }

    if (input.allowAsync && input.mode === "swap") {
      parts.push("--allow-async");
    }
  }

  // Copy-CLI extras (Settings). Emitted for every mode, including send.
  // `--simu` needs a built tx, so `-d` is always included when simu is on.
  const json = input.json === true;
  const simu = input.simu === true;
  const data = (input.data ?? true) || simu;
  if (json) parts.push("--json");
  if (data) parts.push("-d");
  if (simu) parts.push("--simu");

  return parts.join(" ");
}

/** One-shot install line for the current origin (or a fixed public host). */
export function installCliCommand(origin?: string): string {
  const base =
    origin && /^https?:\/\//.test(origin)
      ? origin.replace(/\/$/, "")
      : "https://swap.9summits.io";
  return `curl -fsSL ${base}/install.sh | bash`;
}

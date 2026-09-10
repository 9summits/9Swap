import pc from "picocolors";
import type { ChainInfo } from "./chains.ts";
import type { Token } from "./tokens.ts";
import type {
  NormalizedOrder,
  NormalizedQuote,
  NormalizedTx,
  TokenHint,
  Venue,
  VenueResult,
} from "./venues/index.ts";
import { isAsyncVenue } from "./venues/index.ts";
import type { TradeSide } from "./trade_side.ts";
import {
  netUsdOf,
  sellAmountOutForRank,
  sortRoutesBySide,
  toRankQuote,
  type RankMode,
} from "../shared/rank.ts";
import type { SimulateResult } from "./simulate.ts";
import { fromBaseUnits, formatUsd } from "./amount.ts";
import { toChecksumAddress } from "./checksum.ts";

const HR = pc.dim("─".repeat(56));

/** One-shot stderr note when `-v all` drops venues for a missing API key. */
export function formatMissingApiKeyNote(
  skips: ReadonlyArray<{ venue: Venue; envVar: string }>,
): string | null {
  if (skips.length === 0) return null;
  const names = skips.map((s) => s.venue).join(", ");
  const vars = [...new Set(skips.map((s) => s.envVar))].join(", ");
  return (
    `${pc.yellow("!")} skipped ${names} — no API key\n` +
    pc.dim(`  set ${vars} in .env to include those venues`)
  );
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Pad a string to `width` visible characters, ignoring ANSI escape sequences
// in the length count. Plain `.padEnd(n)` over-counts when `pc.dim()` etc.
// have wrapped a substring with control codes.
function padVisible(s: string, width: number): string {
  const visible = s.replace(ANSI_RE, "").length;
  return s + " ".repeat(Math.max(0, width - visible));
}

export function renderQuote(args: {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  quote: NormalizedQuote;
  intermediaries?: Map<string, TokenHint>;
}): string {
  const { chain, tokenIn, tokenOut, quote, intermediaries } = args;

  const labels = combinedLabels(tokenIn, tokenOut, quote, intermediaries);

  const amountInHuman = fromBaseUnits(quote.amountIn, tokenIn.decimals, 8);
  const amountOutHuman = fromBaseUnits(quote.amountOut, tokenOut.decimals, 8);

  const inUsd = quote.amountInUsd;
  const outUsd = quote.amountOutUsd;
  const gasUsd = quote.gasUsd;

  const impact =
    inUsd !== null && outUsd !== null && inUsd > 0
      ? ((outUsd - inUsd) / inUsd) * 100
      : NaN;

  const rate =
    Number(amountOutHuman) && Number(amountInHuman)
      ? Number(amountOutHuman) / Number(amountInHuman)
      : NaN;

  const rows: Array<[string, string]> = [
    [
      "rate",
      Number.isFinite(rate)
        ? `1 ${tokenIn.symbol} = ${formatNum(rate)} ${tokenOut.symbol}`
        : "—",
    ],
    [
      "inverse",
      Number.isFinite(rate) && rate > 0
        ? `1 ${tokenOut.symbol} = ${formatNum(1 / rate)} ${tokenIn.symbol}`
        : "—",
    ],
    ["gas", fmtGas(quote.gasUnits, gasUsd, quote.gasPriceWei)],
  ];
  if (quote.protocolFee) {
    const feeToken =
      quote.protocolFee.side === "in" ? tokenIn : tokenOut;
    rows.push([
      "protocolFee",
      fmtProtocolFee(quote.protocolFee, feeToken),
    ]);
  }
  rows.push(
    ["chain", `${chain.displayName} ${pc.dim(`(${chain.chainId})`)}`],
    ["venue", quote.venue],
    ["tokenIn", fmtToken(tokenIn, chain)],
    ["tokenOut", fmtToken(tokenOut, chain)],
  );
  const labelWidth = Math.max(...rows.map(([k]) => k.length));

  const lines: string[] = [];
  lines.push(HR);

  lines.push("  " + pc.cyan("route"));
  lines.push(renderRoute(quote, labels));
  lines.push(HR);

  for (const [k, v] of rows) {
    lines.push(`  ${pc.cyan(k.padEnd(labelWidth))}  ${v}`);
  }
  lines.push(HR);

  lines.push(
    "  " +
      pc.bold(`${amountInHuman} ${tokenIn.symbol}`) +
      pc.dim("  →  ") +
      pc.bold(pc.green(`${amountOutHuman} ${tokenOut.symbol}`)) +
      (quote.minAmountOut
        ? pc.dim(
            `  min ${fromBaseUnits(quote.minAmountOut, tokenOut.decimals, 8)} ${tokenOut.symbol}`,
          )
        : "") +
      pc.dim(`   via ${quote.venue}`),
  );
  lines.push(
    "  " +
      pc.dim(formatUsd(inUsd ?? undefined)) +
      pc.dim("  →  ") +
      pc.dim(formatUsd(outUsd ?? undefined)) +
      (Number.isFinite(impact) ? "  " + colorImpact(impact) : ""),
  );
  lines.push(HR);

  return lines.join("\n");
}

function renderRoute(
  quote: NormalizedQuote,
  labels: Map<string, string>,
): string {
  if (!quote.hops || quote.hops.length === 0) {
    return "    " + pc.dim("(no route)");
  }

  type Entry = {
    tokenIn: string;
    tokenOut: string;
    swap: bigint;
    exchange: string;
    fee: number | undefined;
  };
  const entries: Entry[] = quote.hops.map((h) => ({
    tokenIn: h.tokenIn,
    tokenOut: h.tokenOut,
    swap: BigInt(h.swapAmount || "0"),
    exchange: h.exchange,
    fee: h.fee,
  }));

  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const arr = groups.get(e.tokenIn) ?? [];
    arr.push(e);
    groups.set(e.tokenIn, arr);
  }

  const out: string[] = [];
  const keys = [...groups.keys()];

  keys.forEach((key, gi) => {
    const list = groups.get(key)!;
    const total = list.reduce((a, b) => a + b.swap, 0n);
    const inLabel = labels.get(key) ?? shortAddr(key);

    const isLastGroup = gi === keys.length - 1;
    const gBranch = isLastGroup ? "└─" : "├─";
    const gVert = isLastGroup ? "   " : "│  ";

    out.push(
      `    ${pc.dim(gBranch)} split on ${pc.bold(inLabel)} ${pc.dim(`(${list.length})`)}`,
    );

    list.forEach((e, i) => {
      const last = i === list.length - 1;
      const branch = last ? "└─" : "├─";
      const pct =
        list.length === 1
          ? "100.0"
          : total > 0n
            ? (Number((e.swap * 10000n) / total) / 100).toFixed(1)
            : "?";
      const outLabel = labels.get(e.tokenOut) ?? shortAddr(e.tokenOut);
      const feeSuffix = e.fee !== undefined ? ` ${pc.magenta(fmtFeeTier(e.fee))}` : "";
      out.push(
        `    ${pc.dim(gVert)}${pc.dim(branch)} ${pc.yellow(`${pct}%`.padStart(6))} ${pc.dim("→")} ${outLabel}  ${pc.dim(`via ${e.exchange}`)}${feeSuffix}`,
      );
    });
  });

  return out.join("\n");
}

export function renderApproval(args: {
  tokenIn: Token;
  current: bigint;
  needed: bigint;
  sufficient: boolean;
  spender: string;
  approveTx: NormalizedTx | null;
}): string {
  const { tokenIn, current, needed, sufficient, spender, approveTx } = args;

  const currentHuman = fromBaseUnits(current.toString(), tokenIn.decimals, 8);
  const neededHuman = fromBaseUnits(needed.toString(), tokenIn.decimals, 8);

  const lines: string[] = [];
  if (sufficient) {
    lines.push(
      `  ${pc.green("✓")} ${pc.bold("allowance ok")} ${pc.dim(
        `— spender has ${currentHuman} ${tokenIn.symbol} (need ${neededHuman})`,
      )}`,
    );
    return lines.join("\n");
  }

  lines.push(
    `  ${pc.yellow("!")} ${pc.bold(pc.yellow("approval needed"))} ${pc.dim(
      `— current ${currentHuman} ${tokenIn.symbol}, need ${neededHuman}`,
    )}`,
  );
  lines.push("");

  if (!approveTx) {
    lines.push(`    ${pc.dim("(no approve tx built)")}`);
    return lines.join("\n");
  }

  const rows: Array<[string, string]> = [
    ["to", `${toChecksumAddress(approveTx.to)} ${pc.dim(`(${tokenIn.symbol})`)}`],
    ["from", approveTx.from ?? "—"],
    ["spender", toChecksumAddress(spender)],
    ["value", "0"],
    ["amount", `${neededHuman} ${tokenIn.symbol} ${pc.dim(`(${needed} raw)`)}`],
    [
      "priorityFee",
      approveTx.maxPriorityFeePerGas
        ? `${fmtGweiSafe(approveTx.maxPriorityFeePerGas)} gwei`
        : "—",
    ],
    ["chainId", String(approveTx.chainId)],
    [
      "data",
      pc.dim(`(${(approveTx.data.length - 2) / 2} bytes)`),
    ],
  ];

  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  lines.push("  " + pc.cyan("approve tx"));
  for (const [k, v] of rows) {
    lines.push(`    ${pc.cyan(k.padEnd(labelWidth))}  ${v}`);
  }
  lines.push(approveTx.data);
  return lines.join("\n");
}

export type SimulationOutcome =
  | { kind: "ok"; result: SimulateResult }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

export function renderSimulation(args: {
  outcome: SimulationOutcome;
  tokenIn: Token;
  tokenOut: Token;
  quotedAmountOut: string;
  watchAddress?: string | null;
}): string {
  const { outcome, tokenIn, tokenOut, quotedAmountOut, watchAddress } = args;
  const lines: string[] = [];
  lines.push("  " + pc.cyan("simulation"));

  if (outcome.kind === "skipped") {
    lines.push(
      `    ${pc.cyan("skipped".padEnd(10))}  ${pc.dim(outcome.reason)}`,
    );
    return lines.join("\n");
  }
  if (outcome.kind === "error") {
    lines.push(
      `    ${pc.cyan("error".padEnd(10))}  ${pc.red(outcome.message)}`,
    );
    return lines.join("\n");
  }

  const r = outcome.result;
  const labelWidth = 10;
  const fmtStatus = (s: "ok" | "reverted" | "skipped"): string =>
    s === "ok"
      ? `${pc.green("✓")} ok`
      : s === "reverted"
        ? `${pc.red("✗")} reverted`
        : pc.dim("— skipped");
  const fmtGas = (g: bigint | null): string =>
    g !== null ? pc.dim(`gas ${Number(g).toLocaleString("en-US")}`) : "";

  lines.push(
    `    ${pc.cyan("approve".padEnd(labelWidth))}  ${fmtStatus(r.approveStatus)}` +
      (r.approveGasUsed !== null ? `   ${fmtGas(r.approveGasUsed)}` : ""),
  );

  const swapLine =
    `    ${pc.cyan("swap".padEnd(labelWidth))}  ${fmtStatus(r.swapStatus)}` +
    (r.swapGasUsed !== null ? `   ${fmtGas(r.swapGasUsed)}` : "");
  lines.push(swapLine);
  if (r.swapStatus === "reverted" && r.swapRevertReason) {
    lines.push(
      `    ${pc.cyan("reason".padEnd(labelWidth))}  ${pc.red(r.swapRevertReason)}`,
    );
  }

  if (r.swapStatus === "ok") {
    const receivedHuman = fromBaseUnits(
      r.tokenOutReceived.toString(),
      tokenOut.decimals,
      8,
    );
    const quoted = Number(
      fromBaseUnits(quotedAmountOut, tokenOut.decimals, 12),
    );
    const real = Number(receivedHuman);
    const deltaPct = quoted > 0 ? ((real - quoted) / quoted) * 100 : NaN;
    const deltaStr = Number.isFinite(deltaPct)
      ? colorImpact(deltaPct)
      : pc.dim("—");
    lines.push(
      `    ${pc.cyan("received".padEnd(labelWidth))}  ${pc.bold(`${receivedHuman} ${tokenOut.symbol}`)}   ${pc.dim(`vs ${formatNum(quoted)} quoted`)}  ${deltaStr}`,
    );
  }

  // --debug: report ERC20 Transfers landing at any watched address
  // during the simulated swap. Grouped by destination and labeled with
  // the watch's tag (e.g. "REFERRAL", "velora vault — claim via …"),
  // so the user can tell a direct partner-fee transfer apart from a
  // protocol vault accrual. Tokens get resolved to symbol/decimals
  // via tokenIn/tokenOut; everything else prints as raw bigint.
  if (r.watchedTransfers !== null) {
    const knownTokens = new Map<string, Token>([
      [tokenIn.address.toLowerCase(), tokenIn],
      [tokenOut.address.toLowerCase(), tokenOut],
    ]);
    const fmtAmount = (token: string, amount: bigint): string => {
      const known = knownTokens.get(token);
      return known
        ? `${fromBaseUnits(amount.toString(), known.decimals, 8)} ${known.symbol}`
        : `${amount.toString()} ${pc.dim(`raw @ ${token}`)}`;
    };

    if (r.watchedTransfers.length === 0) {
      const refLabel = watchAddress
        ? toChecksumAddress(watchAddress)
        : pc.dim("(unset)");
      lines.push(
        `    ${pc.cyan("referral".padEnd(labelWidth))}  ${pc.dim(`no transfers to ${refLabel}`)}`,
      );
    } else {
      // First transfer takes the `referral` label; the rest stack
      // underneath. Skipping the destination header line: when the
      // user passed --debug they already know where they're watching,
      // and the from-address is the one piece they don't.
      let first = true;
      for (const t of r.watchedTransfers) {
        const heading = first ? "referral" : "";
        lines.push(
          `    ${pc.cyan(heading.padEnd(labelWidth))}  ${pc.green("✓")} ${fmtAmount(t.token, t.amount)}  ${pc.dim(`from ${toChecksumAddress(t.from)}`)}`,
        );
        first = false;
      }
    }
  }

  return lines.join("\n");
}

export function renderOrder(order: NormalizedOrder): string {
  const now = Math.floor(Date.now() / 1000);
  const remainSec = order.validUntilSec - now;
  const validIso = new Date(order.validUntilSec * 1000).toISOString();
  const validHuman =
    remainSec > 0
      ? `in ${remainSec}s`
      : pc.red(`expired ${Math.abs(remainSec)}s ago`);

  const rows: Array<[string, string]> = [
    ["kind", `eip-712 (sign + POST)`],
    ["venue", order.venue],
    ["spender", toChecksumAddress(order.spender)],
    ["signer", toChecksumAddress(order.signer)],
    ["submit", `${order.submit.method} ${order.submit.url}`],
    ["validUntil", `${validIso} ${pc.dim(`(${validHuman})`)}`],
    ["chainId", String(order.chainId)],
  ];
  if (order.submit.auth) {
    const header =
      order.submit.auth.kind === "api-key"
        ? `x-api-key: $${order.submit.auth.envVar}`
        : `authorization: Bearer $${order.submit.auth.envVar}`;
    rows.splice(5, 0, [
      "auth",
      `${header} ${pc.dim("(required by the relayer)")}`,
    ]);
  }
  if (order.orderHash) {
    rows.push(["orderHash", order.orderHash]);
  }

  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const lines: string[] = [];
  lines.push("  " + pc.cyan("order"));
  for (const [k, v] of rows) {
    lines.push(`    ${pc.cyan(k.padEnd(labelWidth))}  ${v}`);
  }
  // The EIP-712 typed data is bulky; pipe it through --json for signing
  // tools that take a file path.
  lines.push(
    `    ${pc.cyan("sign".padEnd(labelWidth))}  ` +
      pc.dim(
        `re-run with --json | jq .order.typedData > order.json && \\\n` +
          `${" ".repeat(labelWidth + 6)}cast wallet sign-typed-data --data @order.json`,
      ),
  );
  return lines.join("\n");
}

export function renderTx(tx: NormalizedTx): string {
  const dataBytes = tx.data.startsWith("0x") ? (tx.data.length - 2) / 2 : 0;
  const gasStr = tx.gas
    ? `${Number(tx.gas).toLocaleString("en-US")} units`
    : "—";
  const gasPriceStr = tx.gasPrice
    ? `${fmtGweiSafe(tx.gasPrice)} gwei ${pc.dim(`(${tx.gasPrice} wei)`)}`
    : "—";
  const valueStr =
    tx.value === "0"
      ? "0"
      : `${tx.value} wei ${pc.dim(`(~${(Number(tx.value) / 1e18).toFixed(6)} native)`)}`;

  const rows: Array<[string, string]> = [
    ["to", toChecksumAddress(tx.to)],
    ["from", tx.from ?? "—"],
    ["spender", toChecksumAddress(tx.spender)],
    ["value", valueStr],
    ["gas", gasStr],
    ["gasPrice", gasPriceStr],
    [
      "priorityFee",
      tx.maxPriorityFeePerGas
        ? `${fmtGweiSafe(tx.maxPriorityFeePerGas)} gwei ${pc.dim(`(${tx.maxPriorityFeePerGas} wei)`)}`
        : "—",
    ],
    ["chainId", String(tx.chainId)],
    ["data", pc.dim(`(${dataBytes.toLocaleString("en-US")} bytes)`)],
  ];

  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const lines: string[] = [];
  lines.push("  " + pc.cyan("swap tx"));
  for (const [k, v] of rows) {
    lines.push(`    ${pc.cyan(k.padEnd(labelWidth))}  ${v}`);
  }
  lines.push(tx.data);
  return lines.join("\n");
}

function fmtGweiSafe(weiPrice: string): string {
  try {
    const wei = BigInt(weiPrice);
    const gwei = Number(wei) / 1e9;
    return gwei.toFixed(gwei < 1 ? 3 : 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`! could not parse gas price "${weiPrice}": ${msg}`);
    return "?";
  }
}

// Pairs of venues that share an upstream API and split routing between
// them — when one returns a route, the other's adapter naturally errors
// ("no intent route available" / "best route is DUTCH_V2"). That sibling
// error is just noise in the comparison block, so we suppress it
// whenever its complement succeeded. Single-venue queries (`-v uniswap`
// alone) still surface the error to the user.
const COMPLEMENT_PAIRS: ReadonlyArray<readonly [Venue, Venue]> = [
  ["uniswap", "uniswapx"],
];

export function suppressedSiblings(successVenues: Set<Venue>): Set<Venue> {
  const suppressed = new Set<Venue>();
  for (const [a, b] of COMPLEMENT_PAIRS) {
    if (successVenues.has(a)) suppressed.add(b);
    if (successVenues.has(b)) suppressed.add(a);
  }
  return suppressed;
}

export function renderComparison(args: {
  results: VenueResult[];
  best: Venue | null;
  tokenIn: Token;
  tokenOut: Token;
  side?: TradeSide;
  rank: RankMode;
  // Venues excluded from the exact-out race entirely (no native buy AND not
  // reached by sell-refine — e.g. missing seed or filtered out). Rendered as
  // dim "skipped — no exact-out support (sell-only)" rows. Sell-only venues
  // that competed via refine appear as normal success/error rows instead.
  skipped?: Venue[];
}): string {
  const { results, best, tokenIn, tokenOut, side = "sell", rank, skipped } = args;
  // Buy ranks/compares the variable leg = amountIn (what you pay, in tokenIn),
  // lower is better. Sell ranks the variable leg = amountOut (tokenOut), higher
  // is better. The fixed leg is identical across venues, so showing it would
  // make every row look the same.
  const buy = side === "buy";
  const amountToken = buy ? tokenIn : tokenOut;
  const amountOf = (q: NormalizedQuote) => (buy ? q.amountIn : q.amountOut);
  const rankOf = (q: NormalizedQuote) =>
    buy ? q.amountIn : sellAmountOutForRank(q);
  const successes = results.flatMap((r) =>
    "quote" in r ? [{ venue: r.venue, quote: r.quote }] : [],
  );
  const successVenues = new Set(successes.map((s) => s.venue));
  const suppressed = suppressedSiblings(successVenues);
  const failures = results.flatMap((r) =>
    "error" in r && !suppressed.has(r.venue)
      ? [{ venue: r.venue, error: r.error }]
      : [],
  );

  const ranked = sortRoutesBySide(
    successes.map((s) => ({
      ...s,
      ...toRankQuote(s.quote, isAsyncVenue(s.venue)),
    })),
    side,
    rank,
  );

  const bestAmount = ranked[0]
    ? Number(fromBaseUnits(rankOf(ranked[0].quote), amountToken.decimals, 12))
    : 0;
  const winnerRow = ranked.find((s) => s.venue === best) ?? ranked[0];
  const bestNet =
    rank.mode === "net" && winnerRow
      ? netUsdOf(winnerRow, side, rank)
      : null;

  const lines: string[] = [];
  lines.push("  " + pc.cyan("venues"));
  for (const s of ranked) {
    const human = Number(
      fromBaseUnits(amountOf(s.quote), amountToken.decimals, 12),
    );
    const rankHuman = Number(
      fromBaseUnits(rankOf(s.quote), amountToken.decimals, 12),
    );
    const isBest = s.venue === best;
    const isAsync = isAsyncVenue(s.venue);
    const marker = isBest ? pc.green("★") : " ";
    const venueLabel = isAsync
      ? `${s.venue} ${pc.dim("(intent)")}`
      : s.venue;
    const minNote =
      !buy && s.quote.minAmountOut
        ? ` ${pc.dim(`min ${formatNum(Number(fromBaseUnits(s.quote.minAmountOut, amountToken.decimals, 12)))}`)}`
        : "";
    const amountStr = `${formatNum(human)} ${amountToken.symbol}${minNote}`;
    const gasStr =
      s.quote.gasUsd !== null
        ? formatUsd(s.quote.gasUsd)
        : isAsync
          ? pc.dim("filler")
          : "—";
    let deltaStr: string;
    if (isBest) {
      deltaStr = pc.green("best");
    } else if (rank.mode === "net" && bestNet != null && bestNet !== 0) {
      const rowNet = netUsdOf(s, side, rank);
      deltaStr =
        rowNet == null
          ? pc.dim("—")
          : colorDelta(
              ((buy ? bestNet - rowNet : rowNet - bestNet) /
                Math.abs(bestNet)) *
                100,
            );
    } else if (bestAmount === 0) {
      deltaStr = pc.green("best");
    } else {
      deltaStr = colorDelta(
        (buy
          ? (bestAmount - rankHuman) / bestAmount
          : (rankHuman - bestAmount) / bestAmount) * 100,
      );
    }
    // Pad `gas $X.XX` to a fixed visible width so the delta column lines
    // up across rows. USD strings vary from `$0.00` to `$0.123456` (and
    // longer for congestion), and without padding the delta drifts left
    // or right by 1-3 chars per row.
    const gasField = padVisible(pc.dim(`gas ${gasStr}`), 18);
    lines.push(
      `    ${marker} ${padVisible(pc.bold(venueLabel), 17)} ${amountStr.padEnd(28)} ${gasField}  ${deltaStr}`,
    );
  }
  for (const f of failures) {
    const isAsync = isAsyncVenue(f.venue);
    const venueLabel = isAsync
      ? `${f.venue} ${pc.dim("(intent)")}`
      : f.venue;
    lines.push(
      `      ${padVisible(pc.dim(venueLabel), 17)} ${pc.red("error")}  ${pc.dim(f.error)}`,
    );
  }
  for (const v of skipped ?? []) {
    const isAsync = isAsyncVenue(v);
    const venueLabel = isAsync ? `${v} ${pc.dim("(intent)")}` : v;
    lines.push(
      `      ${padVisible(pc.dim(venueLabel), 17)} ${pc.dim("skipped")}  ${pc.dim("no exact-out support (sell-only)")}`,
    );
  }
  return lines.join("\n");
}

// One-row formatter used while quotes are streaming in. Shape mirrors
// renderComparison's success/failure rows. The marker is:
//   ★ for the current best (passed isBest=true)
//   (space) for a settled non-best success — matches the comparison
//   block convention rather than introducing a checkmark
// Errors render without a marker (just a dimmed venue label and the
// error text), again matching renderComparison.
// The trailing column is arrival time (not delta-vs-best, which can't
// be computed until every quote is in).
export function renderProgressRow(
  result: VenueResult,
  elapsedMs: number,
  tokenIn: Token,
  tokenOut: Token,
  side: TradeSide,
  isBest = false,
): string {
  const elapsed = `(${(elapsedMs / 1000).toFixed(1)}s)`;
  const isAsync = isAsyncVenue(result.venue);
  const venueLabel = isAsync
    ? `${result.venue} ${pc.dim("(intent)")}`
    : result.venue;

  if ("error" in result) {
    return `      ${padVisible(pc.dim(venueLabel), 17)} ${pc.red("error")}  ${pc.dim(result.error)}   ${pc.dim(elapsed)}`;
  }
  // Buy streams the variable leg = amountIn (what you pay, in tokenIn); sell
  // streams amountOut (tokenOut). The fixed leg is identical across venues.
  const buy = side === "buy";
  const amountToken = buy ? tokenIn : tokenOut;
  const human = Number(
    fromBaseUnits(buy ? result.quote.amountIn : result.quote.amountOut, amountToken.decimals, 12),
  );
  const amountStr = `${formatNum(human)} ${amountToken.symbol}`;
  const gasStr =
    result.quote.gasUsd !== null
      ? formatUsd(result.quote.gasUsd)
      : isAsync
        ? pc.dim("filler")
        : "—";
  const gasField = padVisible(pc.dim(`gas ${gasStr}`), 18);
  const marker = isBest ? pc.green("★") : " ";
  return `    ${marker} ${padVisible(pc.bold(venueLabel), 17)} ${amountStr.padEnd(28)} ${gasField}  ${pc.dim(elapsed)}`;
}

export function combinedLabels(
  tokenIn: Token,
  tokenOut: Token,
  quote: NormalizedQuote,
  intermediaries?: Map<string, TokenHint>,
): Map<string, string> {
  const labels = new Map<string, string>();
  labels.set(tokenIn.address.toLowerCase(), tokenIn.symbol);
  labels.set(tokenOut.address.toLowerCase(), tokenOut.symbol);
  for (const [addr, hint] of quote.tokenHints) {
    if (!labels.has(addr)) labels.set(addr, hint.symbol);
  }
  if (intermediaries) {
    for (const [addr, hint] of intermediaries) {
      if (!labels.has(addr)) labels.set(addr, hint.symbol);
    }
  }
  return labels;
}

function fmtToken(t: Token, chain: ChainInfo): string {
  const addr =
    t.address === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      ? pc.dim("(native)")
      : pc.dim(`${chain.explorer}/token/${t.address}`);
  const src = pc.dim(`[${t.source}]`);
  return `${t.symbol}  ${addr}  ${src}`;
}

function shortAddr(addr: string): string {
  if (!addr.startsWith("0x")) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtFeeTier(fee: number): string {
  // fee is in hundredths of a bp (1/1_000_000). e.g. 500 = 0.05%.
  const pct = fee / 10_000;
  // Strip trailing zeros after the decimal, cap at 3 digits.
  const s = pct.toFixed(3).replace(/\.?0+$/, "");
  return `(${s}%)`;
}

function fmtProtocolFee(
  fee: { raw: string; sharePct: number; side: "in" | "out" },
  feeToken: Token,
): string {
  const human = fromBaseUnits(fee.raw, feeToken.decimals, 8);
  // Tighter precision than gas%: protocol fees can be sub-bp, so 4 decimals.
  const pctStr =
    fee.sharePct >= 0.01
      ? `${fee.sharePct.toFixed(3)}%`
      : `${fee.sharePct.toFixed(4)}%`;
  const sideLabel = fee.side === "in" ? "of input" : "of output";
  return `${human} ${feeToken.symbol}  ${pc.dim(`(${pctStr} ${sideLabel})`)}`;
}

function fmtGas(
  units: number | null,
  usd: number | null,
  priceWei: string | null,
): string {
  if (units === null) return "—";
  const gweiPart = priceWei
    ? ` @ ${fmtGwei(priceWei)} gwei`
    : "";
  return `${units.toLocaleString("en-US")} units  ${pc.dim(
    `(${formatUsd(usd ?? undefined)}${gweiPart})`,
  )}`;
}

function fmtGwei(weiPrice: string): string {
  const wei = BigInt(weiPrice || "0");
  const gwei = Number(wei) / 1e9;
  return gwei.toFixed(gwei < 1 ? 3 : 2);
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 6 : 8;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

function colorImpact(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  const s = `${sign}${pct.toFixed(3)}%`;
  if (pct >= -0.1) return pc.green(s);
  if (pct >= -1) return pc.yellow(s);
  return pc.red(s);
}

function colorDelta(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  const s = `${sign}${pct.toFixed(3)}%`;
  if (pct >= -0.05) return pc.green(s);
  if (pct >= -0.3) return pc.yellow(s);
  return pc.red(s);
}

#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { loadDotenv, maybePromptForRpcConfig } from "./env.ts";
import { toChecksumAddress } from "./checksum.ts";
import { resolveChain } from "./chains.ts";
import {
  getRpcUrl,
  tryRpcUrl,
  setRpcOverride,
  getAllowance,
  getErc20Balance,
  getNativeBalance,
  getPriorityFee,
  buildApproveData,
  redactRpc,
} from "./rpc.ts";
import { resolveToken, resolveAddresses } from "./tokens.ts";
import { toBaseUnits, fromBaseUnits } from "./amount.ts";
import { NATIVE_SENTINEL } from "./tokens.ts";
import {
  fetchQuote,
  fetchAllQuotes,
  fetchAllQuotesStream,
  build,
  pickBest,
  shutdown,
  isAsyncVenue,
  skippedVenues,
  missingApiKeySkips,
  AsyncOptInRequiredError,
  UnsupportedSideError,
  VENUE_OPTIONS,
  VENUES,
  type NormalizedQuote,
  type NormalizedTx,
  type NormalizedOrder,
  type NormalizedPermitTx,
  type Venue,
  type VenueOption,
  type VenueResult,
  assemblePermitTx,
} from "./venues/index.ts";
import {
  renderQuote,
  renderComparison,
  formatMissingApiKeyNote,
  renderTx,
  renderOrder,
  renderApproval,
  renderSimulation,
  renderProgressRow,
  suppressedSiblings,
} from "./format.ts";
import { simulateSwap, type SimulateResult } from "./simulate.ts";
import { getReferralConfig, setNoFeeMode, setReferralMode } from "./referral.ts";
import { setOdosV2NoCompact, setOdosV2DisableRfqs } from "./venues/odosv2.ts";
import { setOdosDisableRfqs } from "./venues/odos.ts";
import { addWallet, listWallets, resolveWalletInput } from "./wallets.ts";
import { startBrowserSession, type SimulateOutcomeWire } from "./browser.ts";
import { fillGasUsd, fillGasUsdAll } from "./gas_usd.ts";
import { fetchTokenPriceUsd } from "./prices.ts";
import { toJson } from "./json.ts";
import type { Token } from "./tokens.ts";
import type { ChainInfo } from "./chains.ts";
import {
  buildWrapTx,
  detectWrap,
  synthQuote,
  type WrapMode,
} from "./wrap.ts";
import { buildSendTx, synthSendQuote } from "./send.ts";
import {
  BASE_CHAIN_ID,
  buildUnwrapWrsethTx,
  makeRsethToken,
  makeWrsethToken,
  synthUnwrapWrsethQuote,
} from "./unwrap_wrseth.ts";
import {
  ETH_CHAIN_ID,
  buildWithdrawSparkWethTx,
  makeSpwethToken,
  makeWethMainnetToken,
  synthWithdrawSparkWethQuote,
} from "./withdraw_spark_weth.ts";
import {
  AVAX_CHAIN_ID,
  buildUnstakeSavaxTx,
  makeAvaxNativeToken,
  makeSavaxToken,
  synthUnstakeSavaxQuote,
} from "./unstake_savax.ts";
import {
  buildClaimSavaxTx,
  discoverClaimableSavax,
  formatClaimSummary,
  synthClaimSavaxQuote,
  type ClaimDiscovery,
} from "./claim_savax.ts";
import { isBuyCapable, type TradeSide } from "./trade_side.ts";
import { maxAmountIn } from "./slippage.ts";
import { runUpdate } from "./update.ts";
import { fetchUsdPrices } from "../web/src/dapp/cgPrices.ts";
import {
  GROSS,
  rankModeFromFetched,
  sortRoutesBySide,
  toRankQuote,
  type RankMode,
} from "../shared/rank.ts";

// Parsed `-v` argument:
//   - "all"   → query every venue available on this chain
//   - Venue   → single venue, single-quote output (no comparison block)
//   - Venue[] → comma-separated list, comparison block over those venues
type VenueArg = VenueOption | Venue[];

function parseVenue(value: string): VenueArg {
  // Comma-separated list. "all" anywhere in the list collapses to "all".
  if (value.includes(",")) {
    const parts = value
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      throw new InvalidArgumentError(`venue list is empty`);
    }
    if (parts.includes("all")) return "all";
    const seen = new Set<Venue>();
    const out: Venue[] = [];
    for (const p of parts) {
      if (!(VENUES as readonly string[]).includes(p)) {
        throw new InvalidArgumentError(
          `unknown venue "${p}". must be one of: ${VENUES.join(", ")}`,
        );
      }
      if (!seen.has(p as Venue)) {
        seen.add(p as Venue);
        out.push(p as Venue);
      }
    }
    return out.length === 1 ? out[0]! : out;
  }
  const v = value.toLowerCase();
  if ((VENUE_OPTIONS as readonly string[]).includes(v)) return v as VenueOption;
  throw new InvalidArgumentError(`must be one of: ${VENUE_OPTIONS.join(", ")}`);
}

type ResolvedCtx = {
  chain: ChainInfo;
  tokenIn: Token;
  tokenOut: Token;
  /** Fixed pay amount for sell; ignored for buy ranking (quote fills amountIn). */
  amountIn?: bigint;
  /** Fixed receive amount for buy (exact-out). */
  amountOut?: bigint;
  side: TradeSide;
  slippageBps: number;
  allowAsync: boolean;
};

async function runSingleVenue(
  venue: Venue,
  ctx: ResolvedCtx,
): Promise<NormalizedQuote> {
  return fetchQuote({
    venue,
    chain: ctx.chain,
    tokenIn: ctx.tokenIn.address,
    tokenOut: ctx.tokenOut.address,
    amountIn: ctx.amountIn,
    amountOut: ctx.amountOut,
    side: ctx.side,
    tokenInDecimals: ctx.tokenIn.decimals,
    tokenOutDecimals: ctx.tokenOut.decimals,
    slippageBps: ctx.slippageBps,
  });
}

// Build an `onProgress` handler that streams each VenueResult to stdout
// as it arrives.
//
// On TTY: every arrival redraws the whole live block ranked the same
// way as the final comparison (errors at the bottom). ANSI cursor-up +
// clear-to-end erases the previous block before each redraw.
//
// On non-TTY (piped): rows print in arrival order with no rewrites — we
// can't un-print after a newline, and arrival timing is the value of the
// streamed rows once they're frozen on the page.
//
// `linesPrinted` is read by the call site to know how many rows to erase
// on TTY before printing the polished comparison block.
function makeStreamingProgress(
  tokenIn: Token,
  tokenOut: Token,
  side: TradeSide,
  getRank: () => RankMode,
): {
  (result: VenueResult, elapsedMs: number): void;
  linesPrinted: number;
} {
  type Entry = { result: VenueResult; elapsedMs: number };
  const entries: Entry[] = [];
  const isTTY = process.stdout.isTTY;
  let lines = 0;

  const sortForDisplay = (xs: Entry[]): Entry[] => {
    const ok = xs.filter((e) => "quote" in e.result);
    const err = xs.filter((e) => "error" in e.result);
    const rankedOk = sortRoutesBySide(
      ok.flatMap((e) => {
        if (!("quote" in e.result)) return [];
        return [
          {
            entry: e,
            ...toRankQuote(e.result.quote, isAsyncVenue(e.result.venue)),
          },
        ];
      }),
      side,
      getRank(),
    ).map((row) => row.entry);
    const successVenues = new Set(rankedOk.map((e) => e.result.venue));
    const suppressed = suppressedSiblings(successVenues);
    const filteredErr = err.filter((e) => !suppressed.has(e.result.venue));
    return [...rankedOk, ...filteredErr];
  };

  const fn = ((result: VenueResult, elapsedMs: number) => {
    entries.push({ result, elapsedMs });
    if (isTTY) {
      if (lines > 0) process.stdout.write(`\x1b[${lines}A\x1b[J`);
      const sorted = sortForDisplay(entries);
      // First success row (if any) is the current best — sorted desc.
      const firstSuccessIdx = sorted.findIndex((e) => "quote" in e.result);
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i]!;
        const isBest = i === firstSuccessIdx;
        process.stdout.write(
          renderProgressRow(e.result, e.elapsedMs, tokenIn, tokenOut, side, isBest) + "\n",
        );
      }
      lines = sorted.length;
    } else {
      // Non-TTY can't retroactively re-mark earlier rows when a later
      // quote beats them, so we don't paint ★ during streaming. The
      // final comparison block at the bottom carries it. Sibling
      // suppression also can't apply here cleanly (we'd need to
      // un-print) — the final block at the end takes care of it.
      process.stdout.write(
        renderProgressRow(result, elapsedMs, tokenIn, tokenOut, side) + "\n",
      );
      lines++;
    }
  }) as ReturnType<typeof makeStreamingProgress>;
  Object.defineProperty(fn, "linesPrinted", {
    get: () => lines,
  });
  return fn;
}

async function runAllVenues(
  ctx: ResolvedCtx,
  onProgress?: (result: VenueResult, elapsedMs: number) => void,
  venuesFilter?: Venue[],
): Promise<VenueResult[]> {
  const raw: VenueResult[] = [];
  const start = Date.now();
  const sharedParams = {
    chain: ctx.chain,
    tokenIn: ctx.tokenIn.address,
    tokenOut: ctx.tokenOut.address,
    amountIn: ctx.amountIn,
    amountOut: ctx.amountOut,
    side: ctx.side,
    tokenInDecimals: ctx.tokenIn.decimals,
    tokenOutDecimals: ctx.tokenOut.decimals,
    slippageBps: ctx.slippageBps,
    allowAsync: ctx.allowAsync,
    venues: venuesFilter,
  };
  if (onProgress) {
    for await (const r of fetchAllQuotesStream(sharedParams)) {
      if ("quote" in r) await fillGasUsd(r.quote, ctx.chain);
      raw.push(r);
      onProgress(r, Date.now() - start);
    }
  } else {
    raw.push(...(await fetchAllQuotes(sharedParams)));
  }
  return raw;
}

async function main(): Promise<void> {
  // `swap update` is a standalone subcommand. First user arg only.
  // `swap 1 WBTC update` must still quote. Handled before loadDotenv so
  // cwd .env, ~/.swap/config, and EMBEDDED_ENV cannot redirect the download.
  // Bun still auto-loads cwd .env; runUpdate ignores a matching SWAP_INSTALL_BASE.
  if (process.argv.slice(2)[0] === "update") {
    await runUpdate();
    return;
  }

  loadDotenv();

  // `swap --init` is a standalone subcommand: prompt for RPC config
  // unconditionally (force=true), write ~/.swap, and exit. Handled
  // before commander parses so we don't trip the required <amount>
  // positional. Accepts any position in argv.
  if (process.argv.slice(2).includes("--init")) {
    await maybePromptForRpcConfig({ force: true });
    return;
  }

  // Sniff --browser before commander so quotes in this process already carry it.
  if (process.argv.includes("--browser")) {
    setReferralMode("browser");
  } else if (process.argv.slice(2).length === 0) {
    // `swap` with no arguments at all launches the interactive dApp: a local
    // web server serving the 9Summits aggregator UI (pick tokens/amount/chain
    // in the browser → compare every venue → pick a route → connect → swap).
    // Any positional/flag args fall through to the normal commander pipeline,
    // so `swap --help`, `swap 1 WBTC ETH`, etc. are unaffected.
    setReferralMode("dapp");
    const { startServeSession } = await import("./serve.ts");
    await startServeSession();
    return;
  } else {
    setReferralMode("cli");
  }

  const program = new Command();

  // Help text is generated at parse time (including `--help`), not inside
  // `.action`. Read argv here so `swap --help --showcustomhelp` also works.
  const actionHelp = process.argv.includes("--showcustomhelp")
    ? "what to do: `swap` (quote + build, default), `send` (transfer the input token to --to), `unwrapwrseth` (Base-only Kelp wrsETH → rsETH), `withdrawsparkweth` (mainnet-only Spark spWETH → WETH), `unstakesavax` (Avalanche-only BENQI sAVAX → AVAX requestUnlock), `claimsavax` (Avalanche-only BENQI sAVAX → AVAX redeem matured unlocks), or `addwallet` (register an alias for an address — usage: `swap -a addwallet <alias> <addr>`)"
    : "what to do: `swap` (quote + build, default), `send` (transfer the input token to --to), or `addwallet` (register an alias for an address — usage: `swap -a addwallet <alias> <addr>`)";

  program
    .name("swap")
    .description(
      "DEX aggregator quotes (kyber | odos | velora | matcha | 1inch | all) from the terminal.\n" +
        "Run `swap --init` once to configure your Alchemy key / RPC URL (saved to ~/.swap).\n" +
        "Run `swap update` to replace this binary with the latest public prebuilt.",
    )
    .argument("<amount>", "amount of tokenIn (or tokenOut with --exact-out), e.g. 1 or 0.25")
    .argument("<tokenIn>", "symbol (WBTC) or 0x address")
    .argument(
      "[tokenOut]",
      "symbol (ETH) or 0x address — required for `-a swap` (the default), ignored for `-a send`",
    )
    .option("-a, --action <action>", actionHelp, "swap")
    .addOption(new Option("--showcustomhelp").hideHelp())
    .option(
      "--to <addr>",
      "recipient address — required with `-a send`",
    )
    .option("-c, --chain <chain>", "chain alias (eth, arb, base, op, avax, bsc, hype, unichain, robinhood, monad, plasma, polygon, gnosis, ink)", "eth")
    .option<VenueArg>(
      "-v, --venue <venue>",
      `aggregator to query (${VENUE_OPTIONS.join(" | ")}) — comma-separated list also accepted, e.g. "kyber,odos,matcha"`,
      parseVenue,
      "all",
    )
    .option("--all", "shortcut for --venue all (query every venue, keep the best)", false)
    .option("--json", "emit structured JSON instead of the formatted breakdown", false)
    .option("-s, --simple", "print only the output amount (tokenOut), for piping", false)
    .option("-d, --data", "also build the swap tx (target, calldata, gas params)", false)
    .option("--from <addr>", "sender / recipient address for tx build; required with -d (or set $SENDER_ADDRESS)")
    .option("--slippage <pct>", "slippage tolerance in % for tx build (e.g. 0.1 = 0.1%, 0.02 = 2bps)", "0.1")
    .option(
      "--allow-async",
      "include async/intent venues (cow, …) — output is an EIP-712 order to sign + POST, not a tx",
      false,
    )
    .option(
      "--simulate",
      "after building the swap tx, simulate it via eth_simulateV1 — pranks tokenIn balance, runs approve + swap, reports tokenOut actually received (sync venues only)",
      false,
    )
    .option("--simu", "alias for --simulate", false)
    .option(
      "--debug",
      "with --simulate: also surface ERC20 transfers landing at REFERRAL_ADDRESS during the simulated swap (verifies partner-fee plumbing)",
      false,
    )
    .option(
      "--rpc <url>",
      "override the RPC URL for this run — takes precedence over RPC_URL_<chainId>, <ALIAS>_RPC_URL, and ALCHEMY_API_KEY. Useful for pointing at a local fork or a faster provider.",
    )
    .option(
      "--browser",
      "open the swap in a local browser page (RainbowKit) instead of dumping calldata — works for both sync tx and async order venues",
      false,
    )
    .option(
      "--nofee",
      "force REFERRAL_FEE_BPS / ODOS_REFERRAL_CODE to 0 for this run on all venues (velora `takeSurplus` / matcha `tradeSurplusRecipient` / `partner` attribution still apply)",
      false,
    )
    .option(
      "--odosnotcompact",
      "force `compact: false` on the odosv2 build-side re-quote (default is `true`)",
      false,
    )
    .option(
      "--disableodosrfq",
      "send `disableRFQs: true` to odos / odosv2 — workaround for tokens whose RFQ leg trips errorCode 2999 on Odos's backend (e.g. FXN)",
      false,
    )
    .option(
      "--exact-out",
      "amount is denominated in tokenOut (buy exact-out): pay as little tokenIn as possible to receive that amount",
      false,
    )
    .showHelpAfterError()
    .action(
      async (
        amountStr: string,
        inArg: string,
        outArg: string | undefined,
        opts: {
          action: string;
          to?: string;
          chain: string;
          venue: VenueOption;
          all: boolean;
          json: boolean;
          simple: boolean;
          data: boolean;
          from?: string;
          slippage: string;
          allowAsync: boolean;
          simulate: boolean;
          simu: boolean;
          debug: boolean;
          rpc?: string;
          browser: boolean;
          nofee: boolean;
          odosnotcompact: boolean;
          disableodosrfq: boolean;
          exactOut: boolean;
          showcustomhelp?: boolean;
        },
      ) => {
        // Validate --action / --to up front so we can branch later.
        if (
          opts.action !== "swap" &&
          opts.action !== "send" &&
          opts.action !== "unwrapwrseth" &&
          opts.action !== "withdrawsparkweth" &&
          opts.action !== "unstakesavax" &&
          opts.action !== "claimsavax" &&
          opts.action !== "addwallet"
        ) {
          throw new Error(
            `--action must be "swap", "send", "unwrapwrseth", "withdrawsparkweth", "unstakesavax", "claimsavax", or "addwallet" (got ${JSON.stringify(opts.action)})`,
          );
        }
        // addwallet is a side-channel action: it reuses the positional
        // slots (amount→alias, tokenIn→addr) and never touches the swap
        // pipeline. Short-circuit before any other validation.
        if (opts.action === "addwallet") {
          if (!inArg) {
            throw new Error(
              `--action addwallet needs two positional args: <alias> <addr>`,
            );
          }
          const entry = addWallet(amountStr, inArg);
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify({ action: "addwallet", ...entry, wallets: listWallets() }, null, 2)}\n`,
            );
          } else {
            process.stderr.write(
              `  ${pc.green("✓")} wallet ${pc.bold(entry.alias)} → ${entry.address}\n`,
            );
            process.stderr.write(`  saved to ~/.swap/wallets.json\n`);
          }
          return;
        }
        const isSend = opts.action === "send";
        const isUnwrapWrseth = opts.action === "unwrapwrseth";
        const isWithdrawSparkWeth = opts.action === "withdrawsparkweth";
        const isUnstakeSavax = opts.action === "unstakesavax";
        const isClaimSavax = opts.action === "claimsavax";
        if (isSend) {
          if (!opts.to) {
            throw new Error(`--action send requires --to <addr>`);
          }
          if (outArg) {
            // tokenOut is meaningless for a send; surface as a soft
            // warning rather than a hard error so users mid-edit don't
            // get blocked.
            console.warn(
              `note: tokenOut "${outArg}" ignored under --action send`,
            );
          }
        } else if (isUnwrapWrseth) {
          // The input/output tokens are fixed to Kelp's wrsETH and
          // rsETH on Base. We don't enforce the spelling of the
          // <tokenIn> arg (the user might type "wrseth", the address,
          // or anything else) — same lenient stance as `-a send`
          // around tokenOut. Just surface a soft warning if outArg
          // doesn't match the implicit rsETH.
          if (opts.chain.toLowerCase() !== "base") {
            throw new Error(
              `--action unwrapwrseth is only supported on Base (got --chain ${opts.chain})`,
            );
          }
          if (outArg && outArg.toLowerCase() !== "rseth") {
            console.warn(
              `note: tokenOut "${outArg}" ignored under --action unwrapwrseth (always rsETH)`,
            );
          }
        } else if (isWithdrawSparkWeth) {
          // Input/output fixed to Spark spWETH (burned) and WETH
          // (received) on mainnet. The <tokenIn> CLI arg is leniently
          // ignored — same stance as unwrapwrseth.
          if (opts.chain.toLowerCase() !== "eth") {
            throw new Error(
              `--action withdrawsparkweth is only supported on Ethereum mainnet (got --chain ${opts.chain})`,
            );
          }
          if (outArg && outArg.toLowerCase() !== "weth") {
            console.warn(
              `note: tokenOut "${outArg}" ignored under --action withdrawsparkweth (always WETH)`,
            );
          }
        } else if (isUnstakeSavax) {
          // Input/output fixed to BENQI sAVAX (debited) and AVAX
          // (queued for unlock) on Avalanche. The <tokenIn> CLI arg is
          // leniently ignored — same stance as the other short-circuit
          // actions.
          if (opts.chain.toLowerCase() !== "avax") {
            throw new Error(
              `--action unstakesavax is only supported on Avalanche (got --chain ${opts.chain})`,
            );
          }
          if (outArg && outArg.toLowerCase() !== "avax") {
            console.warn(
              `note: tokenOut "${outArg}" ignored under --action unstakesavax (always AVAX)`,
            );
          }
        } else if (isClaimSavax) {
          // Claims matured AVAX from queued BENQI unlock requests on
          // Avalanche via redeem(). Both tokens (sAVAX in / AVAX out) are
          // fixed by the action; the <tokenIn> arg is leniently ignored —
          // same stance as the other short-circuit actions. The <amount>
          // positional is also ignored: what gets claimed is whatever is
          // matured on-chain, not a user-supplied amount.
          if (opts.chain.toLowerCase() !== "avax") {
            throw new Error(
              `--action claimsavax is only supported on Avalanche (got --chain ${opts.chain})`,
            );
          }
          if (outArg && outArg.toLowerCase() !== "avax") {
            console.warn(
              `note: tokenOut "${outArg}" ignored under --action claimsavax (always AVAX)`,
            );
          }
        } else {
          // -a swap (default) — tokenOut is required.
          if (!outArg) {
            throw new Error(
              `tokenOut is required for --action swap (use \`-a send --to <addr>\` for a transfer instead)`,
            );
          }
        }

        if (opts.json && opts.simple) {
          throw new Error("--json and --simple are mutually exclusive");
        }
        if (opts.simple && opts.data) {
          throw new Error("--simple and --data are mutually exclusive");
        }
        // Treat --simu as an alias for --simulate.
        if (opts.simu) opts.simulate = true;
        if (opts.simulate && opts.simple) {
          throw new Error("--simulate and --simple are mutually exclusive");
        }
        if (opts.browser && opts.simple) {
          throw new Error("--browser and --simple are mutually exclusive");
        }
        if (opts.browser && opts.json) {
          throw new Error("--browser and --json are mutually exclusive");
        }

        // --rpc <url>: install the override before any RPC consumer runs.
        // Validate as a URL up front so a malformed value fails fast instead
        // of bleeding into venue/curve init with a cryptic error.
        if (opts.rpc) {
          try {
            new URL(opts.rpc);
          } catch {
            throw new Error(`--rpc ${JSON.stringify(opts.rpc)} is not a valid URL`);
          }
          setRpcOverride(opts.rpc);
        }

        // --nofee: zero out explicit revshare fees on every venue for
        // this run. Must be set before any venue adapter calls
        // getReferralConfig() (the result is cached after first read).
        // Surplus capture on velora is keyed on `address`, not
        // `feeBps`, so it stays active.
        if (opts.nofee) setNoFeeMode(true);
        if (opts.odosnotcompact) setOdosV2NoCompact(true);
        if (opts.disableodosrfq) {
          setOdosDisableRfqs(true);
          setOdosV2DisableRfqs(true);
        }

        // First-run interactive prompt for RPC config. No-op when stdin
        // isn't a TTY, when --json/--simple is set, when ~/.swap exists,
        // or when an RPC is already configured. May write ~/.swap and
        // re-load env.
        await maybePromptForRpcConfig({ json: opts.json, simple: opts.simple });

        // --simulate needs the swap calldata to run, so we always build
        // the tx behind the scenes. We do NOT auto-promote --simulate to
        // --data anymore — the calldata blocks (approve tx / swap tx /
        // order) only render when the user explicitly passes -d/--data.
        // The simulation result and the allowance line still print since
        // they're orthogonal to the calldata dump.
        const buildNeeded = opts.data || opts.simulate || opts.browser;
        if (opts.all && program.getOptionValueSource("venue") === "cli" && opts.venue !== "all") {
          throw new Error(`--all conflicts with --venue ${JSON.stringify(opts.venue)}`);
        }
        if (opts.all) opts.venue = "all";

        // For an explicit single async venue, fail loud unless --allow-async.
        // (Async venues inside a comma-list or "all" silently skip — same as
        // the existing -v all behavior; the user gets the rest of the
        // comparison without partial error noise.)
        if (
          opts.venue !== "all" &&
          !Array.isArray(opts.venue) &&
          isAsyncVenue(opts.venue) &&
          !opts.allowAsync
        ) {
          throw new AsyncOptInRequiredError(opts.venue);
        }

        const slippagePct = Number.parseFloat(opts.slippage);
        if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 100) {
          throw new Error(`--slippage must be a number in [0, 100] (percent)`);
        }
        const slippageBps = Math.round(slippagePct * 100);

        // The sender address is baked into the build calldata as the swap
        // output recipient, so it must be a real address the user controls.
        // No placeholder default: -d and amount=max both require an explicit
        // sender, otherwise we'd generate a tx that sends tokens to a burn
        // address or read the balance of a bystander.
        const senderWasProvided =
          opts.from !== undefined ||
          process.env.SENDER_ADDRESS !== undefined;
        if (buildNeeded && !senderWasProvided) {
          const flag = opts.data
            ? "-d"
            : opts.browser
              ? "--browser"
              : "--simulate";
          throw new Error(
            `${flag} requires --from <addr> or SENDER_ADDRESS env — ` +
              `the built calldata encodes the sender as the swap output recipient ` +
              `(and --simulate / --browser need the wallet address to prank or pre-fill)`,
          );
        }
        // Velora rejects addresses that don't match EIP-55 checksum, so
        // normalize whatever the user gives us. --from / SENDER_ADDRESS
        // also accept a wallet alias from ~/.swap/wallets.json — we
        // resolve here so all downstream code sees a 0x address.
        const rawSender = opts.from ?? process.env.SENDER_ADDRESS ?? null;
        const sender = rawSender !== null ? resolveWalletInput(rawSender) : null;

        const chain = resolveChain(opts.chain);

        // For send, there's only one token. We still set tokenOut = tokenIn
        // downstream so the renderer/JSON shape stays uniform — the
        // synth quote labels the hop "transfer to <recipient>" so the
        // intent is unambiguous.
        //
        // For unwrapwrseth / withdrawsparkweth, both tokens are fixed
        // by the action so we skip the resolver entirely; the user
        // can type any placeholder for <tokenIn> and the right pair
        // is used.
        const [tokenIn, tokenOut] = isUnwrapWrseth
          ? [makeWrsethToken(), makeRsethToken()]
          : isWithdrawSparkWeth
            ? [makeSpwethToken(), makeWethMainnetToken()]
            : isUnstakeSavax || isClaimSavax
              ? [makeSavaxToken(), makeAvaxNativeToken()]
              : await Promise.all([
                  resolveToken(inArg, chain),
                  isSend
                    ? resolveToken(inArg, chain)
                    : resolveToken(outArg as string, chain),
                ]);
        if (isUnwrapWrseth && chain.chainId !== BASE_CHAIN_ID) {
          // Defense in depth — the --chain string check above caught
          // the typical case, but resolveChain might map an alias we
          // didn't expect to a different chainId.
          throw new Error(
            `--action unwrapwrseth is Base-only (resolved chainId ${chain.chainId})`,
          );
        }
        if (isWithdrawSparkWeth && chain.chainId !== ETH_CHAIN_ID) {
          throw new Error(
            `--action withdrawsparkweth is mainnet-only (resolved chainId ${chain.chainId})`,
          );
        }
        if (isUnstakeSavax && chain.chainId !== AVAX_CHAIN_ID) {
          throw new Error(
            `--action unstakesavax is Avalanche-only (resolved chainId ${chain.chainId})`,
          );
        }
        if (isClaimSavax && chain.chainId !== AVAX_CHAIN_ID) {
          throw new Error(
            `--action claimsavax is Avalanche-only (resolved chainId ${chain.chainId})`,
          );
        }

        // Validate --to up here (we have the chain context now). Use
        // resolveWalletInput so a wallet alias from ~/.swap/wallets.json
        // works wherever a 0x address would; the result is already
        // checksum-normalized so case-sensitive consumers don't break.
        const recipient =
          isSend && opts.to ? resolveWalletInput(opts.to) : null;
        if (isSend && !recipient) {
          throw new Error(`--action send requires --to <addr>`);
        }

        const amountIsMax = amountStr.toLowerCase() === "max";
        // Sell (default): <amount> is tokenIn. Buy (--exact-out): <amount> is tokenOut.
        const side: TradeSide = opts.exactOut ? "buy" : "sell";
        if (opts.exactOut) {
          if (
            isSend ||
            isUnwrapWrseth ||
            isWithdrawSparkWeth ||
            isUnstakeSavax ||
            isClaimSavax
          ) {
            throw new Error(
              `--exact-out is only supported for -a swap (got -a ${opts.action})`,
            );
          }
          if (amountIsMax) {
            throw new Error(
              `--exact-out does not support amount=max — amount is denominated in tokenOut, not a wallet spend balance`,
            );
          }
          // Explicit single sell-only venue with --exact-out → fail loud
          // (mirrors the async opt-in check above). A comma-list or `-v all`
          // silently drops sell-only venues and surfaces them in the comparison
          // block instead. fetchQuote re-checks as defense in depth.
          if (
            opts.venue !== "all" &&
            !Array.isArray(opts.venue) &&
            !isBuyCapable(opts.venue as Venue)
          ) {
            throw new UnsupportedSideError(opts.venue as Venue);
          }
        }

        let amountIn: bigint | undefined;
        let amountOut: bigint | undefined;
        // claimsavax discovers what's matured on-chain; carried to the
        // synth quote so the JSON `raw` and the rendered amounts match the
        // stderr status summary printed below.
        let claimDiscovery: ClaimDiscovery | null = null;

        if (isClaimSavax) {
          // The <amount> positional is an ignored placeholder — what gets
          // claimed is whatever unlock requests are matured on-chain, not a
          // user-supplied amount. Discover them (needs --from + an RPC) to
          // surface the per-request status and the AVAX amountOut. Without
          // a sender or RPC we still build redeem() (it takes no args), but
          // can't show amounts — warn loudly, mirroring unstake_savax.
          const rpc = tryRpcUrl(chain);
          if (sender && rpc) {
            try {
              claimDiscovery = await discoverClaimableSavax({
                rpc,
                owner: sender,
              });
              amountIn = claimDiscovery.claimableShares;
              if (!opts.json && !opts.simple) {
                for (const line of formatClaimSummary(claimDiscovery, sender)) {
                  console.error(line);
                }
              }
              if (amountIn === 0n) {
                console.error(
                  `! no sAVAX unlock requests are currently within their redeem window — redeem() would claim nothing`,
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(
                `! could not read sAVAX unlock requests: ${msg} — building redeem() anyway, amounts unknown (rpc=${redactRpc(rpc)})`,
              );
              amountIn = 0n;
            }
          } else {
            amountIn = 0n;
            console.error(
              `! claimsavax: set --from <addr> and an RPC (ALCHEMY_API_KEY / AVAX_RPC_URL) to read your unlock requests and the claimable AVAX amount — building redeem() with amounts unknown`,
            );
          }
        } else if (side === "buy") {
          // Exact-out: amount is tokenOut human units.
          amountOut = toBaseUnits(amountStr, tokenOut.decimals);
        } else if (amountIsMax) {
          if (!sender) {
            throw new Error(
              `amount=max requires --from <addr> or SENDER_ADDRESS env — ` +
                `we need an address to read the balance of`,
            );
          }

          const rpc = getRpcUrl(chain);
          const isNativeIn = tokenIn.address.toLowerCase() === NATIVE_SENTINEL;

          if (isNativeIn) {
            const balance = await getNativeBalance(rpc, sender);
            // Reserve a small amount for gas. 1e15 wei = 0.001 native — rough
            // but honest. User can override by passing an exact amount.
            const reserve = 1_000_000_000_000_000n;
            if (balance <= reserve) {
              throw new Error(
                `${sender} has ${balance} wei ${tokenIn.symbol}, ` +
                  `less than the 0.001 ${tokenIn.symbol} gas reserve for max`,
              );
            }
            amountIn = balance - reserve;
          } else {
            amountIn = await getErc20Balance({
              rpc,
              token: tokenIn.address,
              owner: sender,
            });
            if (amountIn === 0n) {
              throw new Error(`${sender} has 0 ${tokenIn.symbol}`);
            }
          }
        } else {
          amountIn = toBaseUnits(amountStr, tokenIn.decimals);
        }

        const ctx: ResolvedCtx = {
          chain,
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
          side,
          slippageBps,
          allowAsync: opts.allowAsync,
        };

        // Native ↔ wrapped-native short-circuit. Skip the venue loop
        // entirely (1:1 rate, no aggregator can offer better) and emit a
        // direct deposit() / withdraw() tx. winner.venue is "wrap" — a
        // pseudo-venue label that bypasses the dispatcher.
        const wrapMode: WrapMode | null = isSend || isUnwrapWrseth || isWithdrawSparkWeth || isUnstakeSavax || isClaimSavax
          ? null
          : detectWrap({
              chain,
              tokenInAddress: tokenIn.address,
              tokenOutAddress: tokenOut.address,
            });
        if (side === "buy" && wrapMode) {
          throw new Error(
            `--exact-out is not supported for wrap/unwrap (native↔wrapped is 1:1; omit --exact-out)`,
          );
        }

        // Short-circuit paths always need a concrete amountIn (sell/special).
        // Buy path only enters the venue loop below.
        const sellAmountIn = (): bigint => {
          if (amountIn == null) {
            throw new Error("internal: amountIn required for sell / short-circuit actions");
          }
          return amountIn;
        };

        let winner: {
          venue:
            | Venue
            | "wrap"
            | "send"
            | "unwrap-wrseth"
            | "withdraw-spark-weth"
            | "unstake-savax"
            | "claim-savax";
          quote: NormalizedQuote;
        };
        let allResults: VenueResult[] | null = null;
        let comparisonRank: RankMode = GROSS;
        // Exact-out only: venues excluded from the race because they're
        // sell-only (no native buy path). Surfaced in the comparison block so
        // `-v all --exact-out` explains why fewer venues competed.
        let sellOnlySkipped: Venue[] = [];

        if (isSend) {
          // Skip the venue loop for send. Synthesize a "transfer"
          // pseudo-quote — the route hop is labelled with the
          // recipient so the rendered output makes the destination
          // unambiguous even without a dedicated send-render path.
          const quote = synthSendQuote({
            token: tokenIn,
            amountIn: sellAmountIn(),
            recipient: recipient as string,
          });
          winner = { venue: "send", quote };
        } else if (isUnwrapWrseth) {
          // Skip the venue loop for the wrsETH unwrap. 1:1 by
          // construction — the contract burns wrsETH from msg.sender
          // and pays out rsETH at parity.
          const quote = synthUnwrapWrsethQuote({ amountIn: sellAmountIn() });
          winner = { venue: "unwrap-wrseth", quote };
        } else if (isWithdrawSparkWeth) {
          // Skip the venue loop for the Spark withdraw. 1:1 — the
          // pool burns spWETH from msg.sender (via pool authority on
          // the aToken) and pays out WETH at par.
          const quote = synthWithdrawSparkWethQuote({ amountIn: sellAmountIn() });
          winner = { venue: "withdraw-spark-weth", quote };
        } else if (isUnstakeSavax) {
          // Skip the venue loop for the sAVAX unstake. The contract
          // call (requestUnlock) queues the shares for redemption —
          // it doesn't return AVAX immediately. amountOut reflects the
          // live sAVAX share price via getPooledAvaxByShares; the
          // helper warns and falls back to 1:1 when no RPC is wired.
          const quote = await synthUnstakeSavaxQuote({
            amountIn: sellAmountIn(),
            rpc: tryRpcUrl(chain),
          });
          winner = { venue: "unstake-savax", quote };
        } else if (isClaimSavax) {
          // Skip the venue loop for the sAVAX claim. redeem() pays out the
          // AVAX value of whatever unlock requests are matured; amountIn /
          // amountOut come from the discovery done in the amountIn branch
          // above (null when no sender/RPC — quote then shows 0).
          const quote = synthClaimSavaxQuote({
            amountIn: sellAmountIn(),
            amountOut: claimDiscovery?.claimableAvax ?? 0n,
            discovery: claimDiscovery,
          });
          winner = { venue: "claim-savax", quote };
        } else if (wrapMode) {
          const quote = synthQuote({
            chain,
            mode: wrapMode,
            tokenInAddress: tokenIn.address,
            tokenOutAddress: tokenOut.address,
            amountIn: sellAmountIn(),
          });
          winner = { venue: "wrap", quote };
        } else {
          // Three input shapes for opts.venue:
          //   "all"       → race every available venue, build a comparison
          //   Venue[]     → race the listed venues only, build a comparison
          //   Venue       → single venue, no comparison block
          const venueArg = opts.venue;
          const isMulti = venueArg === "all" || Array.isArray(venueArg);

          if (isMulti) {
            const venuesFilter = Array.isArray(venueArg)
              ? venueArg
              : undefined;
            const keyNote = formatMissingApiKeyNote(
              missingApiKeySkips({
                allowAsync: ctx.allowAsync,
                venues: venuesFilter,
              }),
            );
            if (keyNote) console.error(keyNote);
            // On exact-out, pre-list sell-only venues; after the race (which
            // includes the sell-refine pass), drop those that actually competed
            // so the comparison doesn't double-show them as "skipped".
            if (side === "buy") {
              const skips = skippedVenues({ allowAsync: ctx.allowAsync, side: "buy" })
                .filter((s) => s.reason === "sell-only")
                .map((s) => s.venue);
              sellOnlySkipped = venuesFilter
                ? skips.filter((v) => venuesFilter.includes(v))
                : skips;
            }
            const showLive = !opts.json && !opts.simple;
            let usdByAddr = new Map<string, number | null>();
            const usdPromise = fetchUsdPrices(chain.chainId, [
              NATIVE_SENTINEL,
              tokenIn.address.toLowerCase(),
              tokenOut.address.toLowerCase(),
            ])
              .then((m) => {
                usdByAddr = m;
                return m;
              })
              .catch((e) => {
                console.error(
                  `CoinGecko USD fetch failed: ${e instanceof Error ? e.message : e}`,
                );
                return usdByAddr;
              });
            const getRank = (): RankMode =>
              rankModeFromFetched({
                side,
                nativeUsd: usdByAddr.get(NATIVE_SENTINEL) ?? null,
                tokenInUsd: usdByAddr.get(tokenIn.address.toLowerCase()) ?? null,
                tokenOutUsd:
                  usdByAddr.get(tokenOut.address.toLowerCase()) ?? null,
                tokenInDecimals: tokenIn.decimals,
                tokenOutDecimals: tokenOut.decimals,
              });
            const onProgress = showLive
              ? makeStreamingProgress(tokenIn, tokenOut, side, getRank)
              : undefined;
            allResults = await runAllVenues(ctx, onProgress, venuesFilter);
            if (showLive && process.stdout.isTTY) {
              const lines = (onProgress as unknown as { linesPrinted: number })
                .linesPrinted;
              if (lines > 0) {
                process.stdout.write(`\x1b[${lines}A\x1b[J`);
              }
            }
            if (side === "buy" && sellOnlySkipped.length > 0) {
              const raced = new Set(allResults.map((x) => x.venue));
              sellOnlySkipped = sellOnlySkipped.filter((v) => !raced.has(v));
            }
            await fillGasUsdAll(allResults, chain);
            await usdPromise;
            const rank = getRank();
            const { best } = pickBest(allResults, side, rank);
            if (!best) {
              const reasons = allResults
                .filter(
                  (r): r is Extract<VenueResult, { error: string }> =>
                    "error" in r,
                )
                .map((r) => `  ${r.venue}: ${r.error}`)
                .join("\n");
              throw new Error(`no venue returned a quote.\n${reasons}`);
            }
            winner = best;
            comparisonRank = rank;
          } else {
            const quote = await runSingleVenue(venueArg, ctx);
            winner = { venue: venueArg, quote };
            await fillGasUsd(winner.quote, chain);
          }
        }

        if (opts.simple) {
          // Sell: pipe amountOut. Buy (--exact-out): pipe amountIn (what you pay).
          if (side === "buy") {
            console.log(
              fromBaseUnits(winner.quote.amountIn, tokenIn.decimals, 12),
            );
          } else {
            console.log(
              fromBaseUnits(winner.quote.amountOut, tokenOut.decimals, 12),
            );
          }
          return;
        }

        // Pay amount for build/allowance: always the quote's amountIn after a
        // successful quote (sell: equals fixed input; buy: estimated pay).
        const payAmountIn = BigInt(winner.quote.amountIn);
        // Approval / simulate ceiling. Sell fixes the input, so the ceiling is
        // the exact pay. Buy authorises up to maxAmountIn (estimate + slippage)
        // — the swap can pull that much if the price moves within tolerance
        // (velora ceils srcAmount, matcha maxSellAmount, cow signs maxSell,
        // uniswap amountInMaximum). Approving only the bare estimate would
        // under-approve and revert. Sell-refine of exact-out is exact-in at the
        // seed pay (no max-in ceiling). Identical to payAmountIn on sell (no-op).
        const allowanceCeiling =
          side === "buy" && !winner.quote.buyRefine
            ? maxAmountIn(payAmountIn, slippageBps)
            : payAmountIn;

        let tx: NormalizedTx | null = null;
        let order: NormalizedOrder | null = null;
        let permitTx: NormalizedPermitTx | null = null;
        let approveTx: NormalizedTx | null = null;
        let allowanceInfo: {
          current: bigint;
          needed: bigint;
          sufficient: boolean;
        } | null = null;

        if (buildNeeded) {
          // The earlier guard guarantees `sender` is non-null when
          // buildNeeded is true; narrow for TypeScript.
          if (!sender) throw new Error("unreachable: sender required for -d / --simulate");

          let spender: string;
          if (isSend) {
            // Direct ERC20 transfer / native value transfer. No
            // allowance check (transfer / msg.value operate on the
            // sender's own balance). recipient is non-null here —
            // validated up top.
            tx = buildSendTx({
              chain,
              sender,
              recipient: recipient as string,
              token: tokenIn,
              amount: payAmountIn,
            });
            spender = tx.spender;
          } else if (isUnwrapWrseth) {
            // wrsETH.withdraw(rsETH, amount) — burns wrsETH from
            // msg.sender, pays out rsETH 1:1. No allowance needed.
            tx = buildUnwrapWrsethTx({ chain, sender, amountIn: payAmountIn });
            spender = tx.spender;
          } else if (isWithdrawSparkWeth) {
            // Spark Pool.withdraw(WETH, amount, sender) — burns spWETH
            // from msg.sender via the pool's onlyPool authority on the
            // aToken, transfers WETH to sender. No allowance needed.
            tx = buildWithdrawSparkWethTx({ chain, sender, amountIn: payAmountIn });
            spender = tx.spender;
          } else if (isUnstakeSavax) {
            // BENQI sAVAX.requestUnlock(shareAmount) — debits sAVAX
            // from msg.sender's own balance and queues the redemption.
            // No allowance needed.
            tx = buildUnstakeSavaxTx({ chain, sender, amountIn: payAmountIn });
            spender = tx.spender;
          } else if (isClaimSavax) {
            // BENQI sAVAX.redeem() — pays out matured AVAX from
            // msg.sender's own queued unlock requests. No allowance needed.
            tx = buildClaimSavaxTx({ chain, sender });
            spender = tx.spender;
          } else if (wrapMode) {
            // Direct WETH9 deposit / withdraw — no dispatcher, no
            // allowance check (deposit takes msg.value; withdraw
            // operates on msg.sender's own WETH balance).
            tx = buildWrapTx({ chain, sender, amountIn: payAmountIn, mode: wrapMode });
            spender = tx.spender;
          } else {
            // Sell-refine quotes (buyRefine) are exact-out intent executed as
            // exact-in: build() rewrites side+slippage from the tag. Native buy
            // still threads amountOut + side=buy for EXACT_OUTPUT adapters.
            const isBuyRefine = !!winner.quote.buyRefine;
            const result = await build(winner.venue as Venue, {
              chain,
              tokenIn: tokenIn.address,
              tokenOut: tokenOut.address,
              tokenInDecimals: tokenIn.decimals,
              tokenOutDecimals: tokenOut.decimals,
              amountIn: payAmountIn,
              amountOut: side === "buy" && !isBuyRefine ? amountOut : undefined,
              side: isBuyRefine ? "sell" : side,
              sender,
              slippageBps,
              quote: winner.quote,
            });

            // Pull spender out of any kind — all three (tx / order /
            // permit-tx) expose it for the allowance check.
            spender = result.spender;
            if (result.kind === "tx") {
              const { kind: _kind, ...txOnly } = result;
              tx = txOnly;
            } else if (result.kind === "order") {
              order = result;
            } else {
              permitTx = result;
            }
          }

          // Soft RPC: graceful degradation when no key is set. -d still
          // produces calldata; we only skip the on-chain reads
          // (allowance + priorityFee) and warn loudly so the user
          // doesn't broadcast without an allowance check.
          const rpc = tryRpcUrl(chain);

          const prioPromise = rpc ? getPriorityFee(rpc) : Promise.resolve(null);

          const isNativeIn = tokenIn.address.toLowerCase() === NATIVE_SENTINEL;
          // Skip the allowance read entirely for wrap or send modes —
          // neither needs an ERC20 approval (deposit pulls via
          // msg.value; withdraw burns msg.sender's own WETH; transfer
          // operates on msg.sender's own balance).
          if (!isNativeIn && !wrapMode && !isSend && !isUnwrapWrseth && !isWithdrawSparkWeth && !isUnstakeSavax && !isClaimSavax) {
            if (!rpc) {
              console.error(
                pc.yellow("!") +
                  " allowance check skipped — no RPC configured. " +
                  pc.dim("verify approval manually before broadcasting"),
              );
            } else {
              try {
                const current = await getAllowance({
                  rpc,
                  token: tokenIn.address,
                  owner: sender,
                  spender,
                });
                const sufficient = current >= allowanceCeiling;
                allowanceInfo = { current, needed: allowanceCeiling, sufficient };
                if (!sufficient) {
                  approveTx = {
                    to: toChecksumAddress(tokenIn.address),
                    from: sender,
                    data: buildApproveData(spender, allowanceCeiling),
                    value: "0",
                    gas: null,
                    // Order has no aggregator-suggested gasPrice; sync tx does.
                    gasPrice: tx?.gasPrice ?? null,
                    maxPriorityFeePerGas: null,
                    spender,
                    chainId: chain.chainId,
                  };
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(
                  pc.yellow("!") + ` allowance check skipped: ${msg} ` +
                    pc.dim(`(rpc=${redactRpc(rpc)})`),
                );
              }
            }
          }

          const prio = await prioPromise;
          if (prio !== null) {
            if (tx) tx.maxPriorityFeePerGas = prio.toString();
            if (approveTx) approveTx.maxPriorityFeePerGas = prio.toString();
          }
        }

        // --simulate: prank tokenIn balance, simulate approve + swap via
        // eth_simulateV1, observe tokenOut actually received. Only meaningful
        // for sync venues (async venues have no callable swap tx).
        //
        // Kicked off as a non-awaited promise so the main output (quote /
        // approval / tx / comparison) prints immediately. Terminal mode
        // awaits + appends the result after everything else; JSON mode
        // awaits before serializing (single-object output requirement).
        type SimulationOutcome =
          | { kind: "ok"; result: SimulateResult }
          | { kind: "skipped"; reason: string }
          | { kind: "error"; message: string };
        let simulationPromise: Promise<SimulationOutcome> | null = null;
        // When --browser is on, simulation is exposed as a button in
        // the page (server-side /simulate endpoint, gated by
        // simulateEnabled). Skip the CLI-side prefetch — it would
        // print a duplicate result to the terminal that the user
        // didn't ask for at quote time.
        if (opts.simulate && !opts.browser) {
          if (!tx) {
            simulationPromise = Promise.resolve({
              kind: "skipped",
              reason: order
                ? "async venue — no callable swap tx to simulate"
                : permitTx
                  ? "permit-tx — assemble requires a real signature, can't simulate at quote time"
                  : "no swap tx was built",
            } satisfies SimulationOutcome);
          } else if (!sender) {
            simulationPromise = Promise.resolve({
              kind: "skipped",
              reason: "no sender resolved",
            } satisfies SimulationOutcome);
          } else {
            const rpc = getRpcUrl(chain);
            const swapTxPayload = { to: tx.to, data: tx.data, value: tx.value };
            const spender = tx.spender;
            const venueForHint = winner.venue;
            // --debug watches transfers landing at REFERRAL_ADDRESS
            // during the simulated swap. The list is plural to keep
            // future flexibility (additional addresses per venue), but
            // every supported venue today routes the partner fee
            // directly to the integrator address — no auxiliary
            // watches needed.
            const watches: { address: string; label: string }[] = [];
            if (opts.debug) {
              const refAddr = getReferralConfig().address;
              if (refAddr) {
                watches.push({ address: refAddr, label: "REFERRAL" });
              }
            }
            simulationPromise = simulateSwap({
              rpc,
              sender,
              tokenIn: tokenIn.address,
              // Buy: prank + approve the slippage ceiling the swap can pull
              // (maxAmountIn), else the simulated approve under-authorises and
              // the exact-out swap reverts. Sell: exact fixed input.
              tokenInAmount: allowanceCeiling,
              tokenOut: tokenOut.address,
              spender,
              swapTx: swapTxPayload,
              watches: watches.length > 0 ? watches : undefined,
            }).then((r): SimulationOutcome => {
              if ("ok" in r) {
                // Append a 1inch-specific hint when the swap reverts —
                // PMM/RFQ legs in 1inch routes can fail at simulation
                // time (the maker's Permit2 nonce gets consumed in
                // another fill between /swap and our simulation). The
                // exact failure shape varies: sometimes it bubbles up as
                // SafeTransferFromFailed, sometimes as a generic
                // "execution reverted" with no revert data (deep call
                // OOG or require-false). Either way the user's real
                // broadcast might still succeed if their tx lands in
                // the right block; the simulation is pessimistic.
                const reason = r.ok.swapRevertReason;
                const isLikelyPmm =
                  venueForHint === "1inch" &&
                  r.ok.swapStatus === "reverted" &&
                  (reason === "SafeTransferFromFailed" ||
                    reason === "execution reverted" ||
                    reason === null);
                const enriched = isLikelyPmm
                  ? `${reason ?? "execution reverted"} — likely a PMM/RFQ leg in the 1inch route that went stale between /swap and simulation. Try \`-v kyber\` / \`-v odos\` for a simulation-friendly route.`
                  : reason;
                return {
                  kind: "ok",
                  result: { ...r.ok, swapRevertReason: enriched },
                };
              }
              if (r.err.kind === "balance-slot-not-found") {
                return {
                  kind: "skipped",
                  reason: `could not find balances slot for ${tokenIn.symbol} at ${r.err.token} — non-standard storage layout`,
                };
              }
              return { kind: "error", message: r.err.message };
            });
          }
        }

        const endpoints = new Set<string>([
          tokenIn.address.toLowerCase(),
          tokenOut.address.toLowerCase(),
        ]);
        const intermediateAddrs = new Set<string>();
        for (const hop of winner.quote.hops) {
          for (const addr of [hop.tokenIn, hop.tokenOut]) {
            const a = addr.toLowerCase();
            if (
              !endpoints.has(a) &&
              !winner.quote.tokenHints.has(a) &&
              a.startsWith("0x")
            ) {
              intermediateAddrs.add(a);
            }
          }
        }
        const intermediaries = await resolveAddresses(
          [...intermediateAddrs],
          chain,
        );

        // Top-level discriminator for JSON consumers: tells scripts whether
        // to broadcast `tx.data`, sign `order.typedData`, or sign
        // `permitTx.typedData` and POST to a follow-up build endpoint.
        // Null when -d wasn't requested.
        const buildKind: "tx" | "order" | "permit-tx" | null = tx
          ? "tx"
          : order
            ? "order"
            : permitTx
              ? "permit-tx"
              : null;

        const toSimulationJson = (sim: SimulationOutcome) =>
          sim.kind === "ok"
            ? {
                status: "ok" as const,
                approve: {
                  status: sim.result.approveStatus,
                  gasUsed: sim.result.approveGasUsed?.toString() ?? null,
                },
                swap: {
                  status: sim.result.swapStatus,
                  gasUsed: sim.result.swapGasUsed?.toString() ?? null,
                  revertReason: sim.result.swapRevertReason,
                },
                tokenOutReceived: {
                  raw: sim.result.tokenOutReceived.toString(),
                  human: fromBaseUnits(
                    sim.result.tokenOutReceived.toString(),
                    tokenOut.decimals,
                    12,
                  ),
                  symbol: tokenOut.symbol,
                },
                watchedTransfers: sim.result.watchedTransfers
                  ? sim.result.watchedTransfers.map((t) => ({
                      token: t.token,
                      from: t.from,
                      to: t.to,
                      label: t.label,
                      amount: t.amount.toString(),
                    }))
                  : null,
              }
            : sim.kind === "skipped"
              ? { status: "skipped" as const, reason: sim.reason }
              : { status: "error" as const, message: sim.message };

        if (opts.json) {
          // JSON output is a single object; await the simulation before
          // serializing.
          const simulation = simulationPromise ? await simulationPromise : null;
          const simulationJson = simulation
            ? toSimulationJson(simulation)
            : null;
          if (allResults) {
            const quotes: Record<string, unknown> = {};
            for (const r of allResults) {
              if ("error" in r) {
                quotes[r.venue] = { error: r.error };
              } else {
                quotes[r.venue] = toJson({
                  chain,
                  tokenIn,
                  tokenOut,
                  quote: r.quote,
                  intermediaries,
                });
              }
            }
            console.log(
              JSON.stringify(
                {
                  venue: "all",
                  best: winner.venue,
                  chain: {
                    alias: chain.alias,
                    chainId: chain.chainId,
                    name: chain.displayName,
                  },
                  tokenIn: {
                    address: tokenIn.address,
                    symbol: tokenIn.symbol,
                    decimals: tokenIn.decimals,
                    source: tokenIn.source,
                  },
                  tokenOut: {
                    address: tokenOut.address,
                    symbol: tokenOut.symbol,
                    decimals: tokenOut.decimals,
                    source: tokenOut.source,
                  },
                  quotes,
                  approval: allowanceInfo
                    ? {
                        needed: !allowanceInfo.sufficient,
                        currentAllowance: allowanceInfo.current.toString(),
                        requiredAllowance: allowanceInfo.needed.toString(),
                        tx: approveTx,
                      }
                    : null,
                  kind: buildKind,
                  tx,
                  order,
                  permitTx,
                  simulation: simulationJson,
                },
                null,
                2,
              ),
            );
            return;
          }
          const payload = toJson({
            chain,
            tokenIn,
            tokenOut,
            quote: winner.quote,
            intermediaries,
          });
          const approvalJson = allowanceInfo
            ? {
                needed: !allowanceInfo.sufficient,
                currentAllowance: allowanceInfo.current.toString(),
                requiredAllowance: allowanceInfo.needed.toString(),
                tx: approveTx,
              }
            : null;
          console.log(
            JSON.stringify(
              {
                ...(payload as object),
                approval: approvalJson,
                kind: buildKind,
                tx,
                order,
                permitTx,
                simulation: simulationJson,
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(
          renderQuote({
            chain,
            tokenIn,
            tokenOut,
            quote: winner.quote,
            intermediaries,
          }),
        );

        // The approval / tx / order blocks dump calldata, which is only
        // wanted when the user explicitly asked for it via -d / --data.
        // Under bare --simulate the tx is built behind the scenes so the
        // simulation can run, but the calldata blocks stay hidden — the
        // simulation block at the bottom is the relevant output.
        if (opts.data) {
          if (allowanceInfo) {
            const spender = tx?.spender ?? order?.spender ?? permitTx?.spender;
            if (spender) {
              console.log(
                renderApproval({
                  tokenIn,
                  current: allowanceInfo.current,
                  needed: allowanceInfo.needed,
                  sufficient: allowanceInfo.sufficient,
                  spender,
                  approveTx,
                }),
              );
            }
          }

          if (tx) {
            console.log(renderTx(tx));
          }
          if (order) {
            console.log(renderOrder(order));
          }
          if (permitTx) {
            // No dedicated terminal renderer yet — the permit-tx flow is
            // designed for --browser, which has its own UI. For -d in
            // terminal mode, surface the typed data + a one-line hint.
            console.log(
              `  permit  sign typed data via wallet, then re-run with --browser to assemble & broadcast`,
            );
            console.log(`          spender (Permit2): ${permitTx.spender}`);
          }
        }

        if (allResults) {
          // Only reachable when !wrapMode (allResults stays null in
          // wrap mode), so winner.venue is always a real Venue here.
          console.log(
            renderComparison({
              results: allResults,
              best: winner.venue as Venue,
              tokenIn,
              tokenOut,
              side,
              rank: comparisonRank,
              skipped: sellOnlySkipped,
            }),
          );
        }

        // Simulation prints last and live — eth_simulateV1 takes ~1-3s,
        // but the user already has every quote / route / tx / comparison
        // block above by the time the promise resolves. On a TTY, show a
        // spinner so they know it's in flight; on a pipe (no TTY), just
        // wait silently and print the result. Either way the main output
        // is non-blocking.
        if (simulationPromise) {
          const tty = process.stdout.isTTY;
          let stop: (() => void) | null = null;
          if (tty) {
            const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
            let i = 0;
            const handle = setInterval(() => {
              process.stdout.write(`\r  simulation  ${frames[i++ % frames.length]} running...`);
            }, 80);
            stop = () => {
              clearInterval(handle);
              process.stdout.write("\r\x1b[2K"); // erase the spinner line
            };
          }
          const simulation = await simulationPromise;
          if (stop) stop();
          console.log(
            renderSimulation({
              outcome: simulation,
              tokenIn,
              tokenOut,
              quotedAmountOut: winner.quote.amountOut,
              watchAddress: opts.debug ? getReferralConfig().address : null,
            }),
          );
        }

        // --browser: hand off to a local Vite + RainbowKit page. The user
        // connects their wallet, the page sends the tx (or signs the
        // order) on their behalf, the result is reported back via /done
        // and we print it here.
        if (opts.browser) {
          if (!sender) {
            // Should never reach here — buildNeeded guard handles it
            // earlier. Belt and suspenders.
            throw new Error("--browser requires --from / SENDER_ADDRESS");
          }
          if (!tx && !order && !permitTx) {
            throw new Error(
              "--browser: no executable tx, order, or permit-tx produced by build",
            );
          }
          const allowanceForBrowser = allowanceInfo
            ? {
                current: allowanceInfo.current,
                needed: allowanceInfo.needed,
                sufficient: allowanceInfo.sufficient,
                approveTx,
              }
            : null;
          // Note: we deliberately do not pass our RPC URL to the page.
          // wagmi/viem use chain-default transports for receipt polling
          // (no Alchemy key in the browser, ever). The /simulate
          // callback below still uses the local RPC server-side.
          // Bind the permit-tx assemble callback. Closes over the
          // original NormalizedQuote so the second leg (POST /v1/swap)
          // sees the exact quote+permitData the user signed against.
          const senderForAssemble = sender;
          const winnerVenue = winner.venue;
          const winnerQuote = winner.quote;
          const assembleCallback: ((sig: string) => Promise<NormalizedTx>) | null =
            permitTx
              ? (signature) =>
                  assemblePermitTx({
                    venue: permitTx!.venue,
                    chain,
                    sender: senderForAssemble,
                    signature,
                    quote: winnerQuote,
                  })
              : null;
          // winnerVenue is unused here directly but kept for symmetry
          // with the assemble closure above; tsc complains otherwise.
          void winnerVenue;

          // Server-side simulate callback. Only wired when there's a
          // callable swap tx — async / permit-tx have nothing to
          // simulate at quote time. Returns a JSON-friendly shape
          // (bigints stringified) so the page can render directly.
          const simulateCallback = tx
            ? async (): Promise<SimulateOutcomeWire> => {
                let simRpc: string;
                try {
                  simRpc = getRpcUrl(chain);
                } catch (e) {
                  return {
                    kind: "skipped",
                    reason: (e as Error).message ?? "no RPC configured",
                  };
                }
                // Run the simulation and the two price fetches in
                // parallel — Alchemy prices is a single HTTP roundtrip
                // each, similar latency to the simulation itself.
                const [r, tokenInPriceUsd, tokenOutPriceUsd] = await Promise.all([
                  simulateSwap({
                    rpc: simRpc,
                    sender,
                    tokenIn: tokenIn.address,
                    // Buy ceiling (maxAmountIn) so the simulated approve covers
                    // what an exact-out swap can pull; sell = exact fixed input.
                    tokenInAmount: allowanceCeiling,
                    tokenOut: tokenOut.address,
                    spender: tx!.spender,
                    swapTx: { to: tx!.to, data: tx!.data, value: tx!.value },
                  }),
                  fetchTokenPriceUsd(chain, tokenIn.address),
                  fetchTokenPriceUsd(chain, tokenOut.address),
                ]);
                if ("ok" in r) {
                  // Same 1inch / PMM hint as the CLI --simu path —
                  // PMM/RFQ legs in 1inch routes can fail at sim time
                  // even when the on-chain broadcast would succeed.
                  const reason = r.ok.swapRevertReason;
                  const isLikelyPmm =
                    winner.venue === "1inch" &&
                    r.ok.swapStatus === "reverted" &&
                    (reason === "SafeTransferFromFailed" ||
                      reason === "execution reverted" ||
                      reason === null);
                  const enriched = isLikelyPmm
                    ? `${reason ?? "execution reverted"} — likely a PMM/RFQ leg in the 1inch route that went stale between /swap and simulation. Try -v kyber or -v odos for a simulation-friendly route.`
                    : reason;
                  return {
                    kind: "ok",
                    approveStatus: r.ok.approveStatus,
                    approveGasUsed: r.ok.approveGasUsed?.toString() ?? null,
                    swapStatus: r.ok.swapStatus,
                    swapGasUsed: r.ok.swapGasUsed?.toString() ?? null,
                    swapRevertReason: enriched,
                    tokenOutReceived: r.ok.tokenOutReceived.toString(),
                    tokenInPriceUsd,
                    tokenOutPriceUsd,
                  };
                }
                if (r.err.kind === "balance-slot-not-found") {
                  return {
                    kind: "skipped",
                    reason: `could not find balances slot for ${tokenIn.symbol} at ${r.err.token} — non-standard storage layout`,
                  };
                }
                return { kind: "error", message: r.err.message };
              }
            : null;

          const session = startBrowserSession({
            venue: winner.venue,
            chain,
            tokenIn,
            tokenOut,
            quote: winner.quote,
            amountIn: payAmountIn,
            sender,
            recipient: isSend ? recipient : null,
            slippageBps,
            simulateEnabled: !!opts.simulate,
            tx,
            order,
            permitTx,
            assemble: assembleCallback,
            simulate: simulateCallback,
            approval: allowanceForBrowser,
          });
          console.log(
            `  ${pc.cyan("browser")}  ${pc.dim("opening")} ${session.url}`,
          );
          console.log(
            `           ${pc.dim("(connect a wallet, then click send / sign — CLI will print the result)")}`,
          );
          const outcome = await session.wait();
          const url = session.url;
          console.log(); // blank line
          if (outcome.kind === "tx-hash") {
            console.log(
              `  ${pc.green("✓")} sent  ${pc.bold(outcome.hash)}`,
            );
            console.log(
              `        ${pc.dim(`${chain.explorer}/tx/${outcome.hash}`)}`,
            );
          } else if (outcome.kind === "order-id") {
            console.log(
              `  ${pc.green("✓")} order submitted  ${pc.bold(outcome.orderId)}`,
            );
          } else if (outcome.kind === "error") {
            console.log(`  ${pc.red("✗")} browser reported: ${outcome.message}`);
            process.exitCode = 1;
          } else {
            console.log(
              `  ${pc.yellow("!")} browser timed out — page never reported back (url: ${url})`,
            );
            process.exitCode = 1;
          }
        }
      },
    );

  await program.parseAsync(process.argv);
}

main()
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(pc.red("✗ ") + msg);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    // curve-js holds an ethers JsonRpcProvider (block-poll timer) and
    // spawns Workers for route-graph/route-finder; under Bun, neither
    // releases cleanly on exit and the CLI hangs after printing its
    // result. shutdown() destroys the provider; process.exit() forces
    // teardown of any remaining Worker handles Bun doesn't surface.
    await shutdown();
    process.exit(process.exitCode ?? 0);
  });

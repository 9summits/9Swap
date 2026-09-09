// Client-side Curve venue — quote + build entirely in the browser.
//
// Why this exists: the Vercel-hosted dApp is stateless and ships with
// SWAP_DISABLE_VENUES=curve, because curve-js's init is a ~12 s on-chain
// AddressProvider/MetaRegistry/factory crawl that can't survive a cold
// serverless start. The local Bun server (the `swap` no-args dApp) keeps
// curve server-side and advertises it in /api/mode's venue list. So when
// the server does NOT offer curve, we run the *same* @curvefi/api library
// in the visitor's tab, against a CORS-open public RPC — the server's Alchemy
// quota is never touched.
//
// This module mirrors src/venues/curve.ts (same library, same call
// sequence: ensureInit → router.getBestRouteAndOutput → router.populateSwap,
// same chainId whitelist, same native-sentinel handling). The one piece we
// deliberately do NOT port is installCurveWorkerSilencer: that's a Bun hack
// to mute curve-js's route-finder Web Worker stdout banners; in a real
// browser those go to the dev console and are harmless.

import {
  encodeFunctionData,
  erc20Abi,
  type EIP1193Provider,
} from "viem";
import { CORS_OPEN_RPC } from "../../publicRpc";
import { knownChains, publicClientFor } from "../../wagmi";
import type { BuildPayload, RouteHop } from "../types";

/* ------------------------------------------------------------------ *
 * Chain whitelist — replicated from src/venues/curve.ts.
 * ------------------------------------------------------------------ */

// Curve has presence on these chains. The server-side adapter keeps the
// same list; replicated here (the contract forbids a new /api/* call to
// discover it) so the client toggle only ever offers curve where it can
// actually quote.
const CURVE_SUPPORTED_CHAIN_IDS = new Set<number>([
  1, // Ethereum
  10, // Optimism
  100, // Gnosis
  // 137 (Polygon) deliberately absent — mirrors src/venues/curve.ts: the
  // curve-js router returns non-executable routes there (see that comment).
  146, // Sonic
  250, // Fantom
  324, // zkSync
  8453, // Base
  42161, // Arbitrum
  43114, // Avalanche
]);

export function curveSupportedChain(chainId: number): boolean {
  return CURVE_SUPPORTED_CHAIN_IDS.has(chainId);
}

/* ------------------------------------------------------------------ *
 * curve-js typing.
 *
 * @curvefi/api's default export is a singleton whose `init` uses a
 * `this:`-bound signature TypeScript dislikes when called as a plain
 * method, and whose router return shape we only partially consume. We
 * model the slice we use with a permissive local type and cast once —
 * mirroring the localized-cast approach in src/venues/curve.ts.
 * ------------------------------------------------------------------ */

type CurveRouteStep = {
  poolId: string;
  swapAddress: string;
  inputCoinAddress: string;
  outputCoinAddress: string;
  poolAddress: string;
};

type CurveInstance = {
  chainId: number;
  init: (
    providerType: "JsonRpc",
    providerSettings: { url?: string; batchMaxCount?: number },
    options?: { chainId?: number },
  ) => Promise<void>;
  factory: { fetchPools: (useApi?: boolean) => Promise<void> };
  cryptoFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  stableNgFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  twocryptoFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  tricryptoFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  crvUSDFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  getCoinsData: (
    addresses: string[],
  ) => Promise<{ name: string; symbol: string; decimals: number }[]>;
  router: {
    getBestRouteAndOutput: (
      inputCoin: string,
      outputCoin: string,
      amount: string | number,
    ) => Promise<{ route: CurveRouteStep[]; output: string }>;
    populateSwap: (
      inputCoin: string,
      outputCoin: string,
      amount: string | number,
      slippage?: number,
    ) => Promise<{
      to?: string;
      data?: string;
      value?: bigint | string | number;
    }>;
  };
};

// Memoized dynamic import. Static import is forbidden by the contract —
// it's what lets Vite emit a lazy chunk in vercel mode and lets the embed
// build mark @curvefi/api external (the local binary never executes this
// path; curve stays server-side there).
let curveModulePromise: Promise<CurveInstance> | null = null;
async function loadCurve(): Promise<CurveInstance> {
  if (!curveModulePromise) {
    curveModulePromise = import("@curvefi/api").then(
      (m) => (m.default ?? m) as unknown as CurveInstance,
    );
  }
  return curveModulePromise;
}

/* ------------------------------------------------------------------ *
 * Per-chain init state.
 *
 * curve-js is a global singleton — it can hold pool/factory state for one
 * chain at a time, so a chain switch forces a re-init + factory re-fetch.
 * We track a single { chainId, status, promise } record and invalidate it
 * the moment a different chain is requested.
 * ------------------------------------------------------------------ */

export type CurveClientStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "unavailable";

type InitState = {
  chainId: number;
  status: CurveClientStatus;
  // Resolves true on ready, false on unavailable. Never rejects — init
  // failures are swallowed to false (the venue simply doesn't appear).
  promise: Promise<boolean>;
};

let initState: InitState | null = null;

export function curveStatus(chainId: number): CurveClientStatus {
  if (initState && initState.chainId === chainId) return initState.status;
  return "idle";
}

// Resolve the public RPC URL curve-js inits against.
//
// Never the injected wallet's provider: curve.init("Web3", …) wraps it in an
// ethers BrowserProvider and asks for a signer, which fires
// eth_requestAccounts. Init runs on its own (a quote auto-refresh warms it),
// so that surfaced as an unsolicited "connect your wallet" popup — Zodiac
// Pilot / the injected multi-wallet picker — with the user never having
// clicked anything. Quoting is read-only; a public RPC covers it.
function resolveInitRpcUrl(chainId: number): string | null {
  const chain = knownChains.find((c) => c.id === chainId);
  // Prefer a CORS-open public RPC over viem's default: several viem defaults
  // (mainnet's eth.merkle.io notably) reject browser-origin requests, which
  // kills the no-wallet curve init outright — and the dApp quotes before any
  // wallet is connected. PublicNode serves permissive CORS on every chain in
  // the curve whitelist and tolerates the init's call volume at
  // batchMaxCount 10.
  const url = CORS_OPEN_RPC[chainId] ?? chain?.rpcUrls.default.http[0];
  if (!url) {
    console.warn(`curve client: no public RPC URL for chain ${chainId}`);
    return null;
  }
  return url;
}

// Re-export so existing `from "./curve/client"` import sites keep working.
export { CORS_OPEN_RPC } from "../../publicRpc";

// Hard ceiling on the whole init. curve-js + ethers can wedge silently on a
// public RPC (a stalled batch never rejects), which would leave warmCurve
// pending forever — no quote, no log, nothing for the user to act on. A
// timed-out init reports "unavailable" cleanly; a later round can retry.
const INIT_TIMEOUT_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms / 1000}s`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function runInit(chainId: number): Promise<boolean> {
  try {
    // Progress breadcrumbs are deliberate console.info — a visitor reporting
    // "curve never shows up" can be diagnosed from their console alone.
    const curve = await loadCurve();
    const url = resolveInitRpcUrl(chainId);
    if (!url) return false;
    console.info(`curve client: init starting (chain ${chainId}, ${url})`);
    // batchMaxCount: 10 matches the CLI — keeps multicall batches from
    // tripping public-RPC request-size limits.
    const initCall = curve.init(
      "JsonRpc",
      { url, batchMaxCount: 10 },
      { chainId },
    );
    await withTimeout(initCall, INIT_TIMEOUT_MS, "curve.init");
    console.info(`curve client: registry init done, fetching pools`);
    // Pull every factory in parallel — one HTTP GET each to
    // api.curve.finance. Individual misses (e.g. crvUSD only on mainnet)
    // are tolerated; curve-js no-ops when the alias isn't present on the
    // chain.
    const settled = await withTimeout(
      Promise.allSettled([
        curve.factory.fetchPools(),
        curve.cryptoFactory.fetchPools(),
        curve.stableNgFactory.fetchPools(),
        curve.twocryptoFactory.fetchPools(),
        curve.tricryptoFactory.fetchPools(),
        curve.crvUSDFactory.fetchPools(),
      ]),
      INIT_TIMEOUT_MS,
      "fetchPools",
    );
    const failed = settled.filter((s) => s.status === "rejected").length;
    console.info(
      `curve client: ready (chain ${chainId}${failed ? `, ${failed}/6 factories unavailable` : ""})`,
    );
    return true;
  } catch (err) {
    console.warn(
      `curve client: init failed for chain ${chainId} — ${(err as Error).message}`,
    );
    // Allow a retry on the next round instead of caching the failure forever:
    // a transient RPC hiccup shouldn't disable curve for the whole session.
    if (initState && initState.chainId === chainId) initState = null;
    return false;
  }
}

// Idempotent warm-up. Starts (or reuses) init for the chain; resolves true
// when ready, false when unavailable. Switching chains discards the prior
// init record (the singleton can't hold two chains at once). Never throws.
export function warmCurve(chainId: number): Promise<boolean> {
  if (!curveSupportedChain(chainId)) {
    return Promise.resolve(false);
  }
  if (initState && initState.chainId === chainId) {
    return initState.promise;
  }
  const state: InitState = {
    chainId,
    status: "initializing",
    promise: Promise.resolve(false),
  };
  state.promise = runInit(chainId).then((ok) => {
    // Only mutate if this is still the active init (a fast chain flip could
    // have superseded us).
    if (initState === state) state.status = ok ? "ready" : "unavailable";
    return ok;
  });
  initState = state;
  return state.promise;
}

/* ------------------------------------------------------------------ *
 * Amount conversion — exact, no float.
 * ------------------------------------------------------------------ */

// curve-js takes amounts as human-unit decimal strings. Convert our base
// units → human with exact decimal placement (no Number()).
function baseToHuman(base: string, decimals: number): string {
  const neg = base.startsWith("-");
  const digits = (neg ? base.slice(1) : base).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  const whole = padded.slice(0, cut);
  const frac = padded.slice(cut).replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${body}` : body;
}

// Convert a human-decimal string (e.g. "418.49156725541576033") to its raw
// bigint with `decimals` places. Truncates beyond `decimals` rather than
// rounding — matches what RouterNG actually returns (same as the CLI's
// humanToBaseUnits).
function humanToBase(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  const dot = trimmed.indexOf(".");
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const frac = dot === -1 ? "" : trimmed.slice(dot + 1);
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")
  );
}

/* ------------------------------------------------------------------ *
 * Native sentinel + address helpers.
 * ------------------------------------------------------------------ */

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function isNative(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === NATIVE_SENTINEL || a === ZERO_ADDR;
}

// Short 0x1234…abcd label for an intermediary coin we couldn't name.
function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// poolId → human-friendly category for the route graph (matches the CLI's
// labelForPoolId).
function labelForPoolId(poolId: string): string {
  if (poolId.startsWith("factory-stable-ng")) return "Curve StableSwap NG";
  if (poolId.startsWith("factory-twocrypto")) return "Curve TwoCrypto NG";
  if (poolId.startsWith("factory-tricrypto")) return "Curve TriCrypto NG";
  if (poolId.startsWith("factory-crvusd")) return "Curve crvUSD pool";
  if (poolId.startsWith("factory-crypto")) return "Curve Factory Crypto";
  if (poolId.startsWith("factory-")) return "Curve Factory Stable";
  return `Curve ${poolId}`;
}

/* ------------------------------------------------------------------ *
 * Quote.
 * ------------------------------------------------------------------ */

export type CurveClientQuote = {
  amountOut: string; // tokenOut BASE UNITS (decimal string)
  amountOutHuman: string; // human units as returned by curve-js
  routeHops: RouteHop[]; // for <RouteGraph>
};

// null when no route / not ready / unsupported pair. Never throws.
export async function quoteCurve(p: {
  chainId: number;
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  amountIn: string; // base units
}): Promise<CurveClientQuote | null> {
  try {
    if (!curveSupportedChain(p.chainId)) return null;
    // Reuse the active init when it's for this chain; otherwise warm it.
    const ready =
      initState &&
      initState.chainId === p.chainId &&
      initState.status === "ready"
        ? true
        : await warmCurve(p.chainId);
    if (!ready) return null;

    const curve = await loadCurve();
    const amountHuman = baseToHuman(p.amountIn, p.tokenIn.decimals);

    const { route, output } = await enqueueRouterCall(
      () =>
        curve.router.getBestRouteAndOutput(
          p.tokenIn.address,
          p.tokenOut.address,
          amountHuman,
        ),
      "getBestRouteAndOutput",
    );
    if (!route?.length) return null;

    const amountOut = humanToBase(output, p.tokenOut.decimals).toString();
    const routeHops = await mapRouteHops(curve, route, p, amountOut);
    return { amountOut, amountOutHuman: output, routeHops };
  } catch (err) {
    console.warn(`curve client: quote failed — ${(err as Error).message}`);
    return null;
  }
}

// SERIALIZED + time-boxed router access. curve-js's route finder
// (worker-backed) is not re-entrant: a second getBestRouteAndOutput issued
// while the first cold computation is still running can leave the first
// promise unresolved forever — observed as "init ready, router graph built,
// then silence" when 30s quote rounds overlap the ~30-60s cold route-finding.
// Queueing every router call through one chain removes the overlap; the
// timeout converts any residual wedge into a logged retry on the next round
// (warm calls resolve in milliseconds, so queue latency is only ever paid
// once, on the first cold call).
const ROUTER_CALL_TIMEOUT_MS = 60_000;
let routerChain: Promise<unknown> = Promise.resolve();

function enqueueRouterCall<T>(fn: () => Promise<T>, what: string): Promise<T> {
  const run = routerChain.then(() =>
    withTimeout(fn(), ROUTER_CALL_TIMEOUT_MS, what),
  );
  // Keep the chain alive whatever happens to this link (never rejects).
  routerChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Map curve-js IRouteStep[] → RouteHop[] for <RouteGraph>. tokenIn/tokenOut
// symbols are known from the caller; intermediary coins are looked up via
// getCoinsData (falling back to a truncated address). getCoinsData failing
// must not sink the quote — the graph just shows addresses.
async function mapRouteHops(
  curve: CurveInstance,
  route: CurveRouteStep[],
  p: {
    tokenIn: { address: string; symbol: string; decimals: number };
    tokenOut: { address: string; symbol: string; decimals: number };
    amountIn: string;
  },
  amountOut: string,
): Promise<RouteHop[]> {
  const known = new Map<string, { symbol: string; decimals: number }>();
  known.set(p.tokenIn.address.toLowerCase(), {
    symbol: p.tokenIn.symbol,
    decimals: p.tokenIn.decimals,
  });
  known.set(p.tokenOut.address.toLowerCase(), {
    symbol: p.tokenOut.symbol,
    decimals: p.tokenOut.decimals,
  });

  const unknown = new Set<string>();
  for (const h of route) {
    for (const a of [h.inputCoinAddress, h.outputCoinAddress]) {
      const lc = a.toLowerCase();
      if (!known.has(lc) && !isNative(lc)) unknown.add(a);
    }
  }
  if (unknown.size > 0) {
    try {
      const addrs = [...unknown];
      const data = await curve.getCoinsData(addrs);
      addrs.forEach((a, i) => {
        const d = data[i];
        if (d) known.set(a.toLowerCase(), { symbol: d.symbol, decimals: d.decimals });
      });
    } catch (err) {
      console.warn(
        `curve client: getCoinsData failed, falling back to addresses — ${(err as Error).message}`,
      );
    }
  }

  // Native coins (0xeee… / 0x000…) on either end map to the caller's token
  // metadata (tokenIn for the route head, tokenOut for the tail). For an
  // intermediary native leg we still show the head/tail symbol — curve never
  // routes through bare native mid-path, so this only matters at the ends.
  const metaFor = (
    addr: string,
    fallbackSide: "in" | "out",
  ): { symbol: string; decimals: number } => {
    if (isNative(addr)) {
      return fallbackSide === "in"
        ? { symbol: p.tokenIn.symbol, decimals: p.tokenIn.decimals }
        : { symbol: p.tokenOut.symbol, decimals: p.tokenOut.decimals };
    }
    return (
      known.get(addr.toLowerCase()) ?? {
        symbol: shortAddr(addr),
        decimals: 18,
      }
    );
  };

  // Curve routes are linear (no splits). For a single path every ribbon
  // carries the full input amount as its weight — uniform width. Only the
  // final hop's tokenOut amount is exposed; intermediates aren't.
  return route.map((h, i) => {
    const fromMeta = metaFor(h.inputCoinAddress, "in");
    const toMeta = metaFor(h.outputCoinAddress, "out");
    return {
      from: fromMeta.symbol,
      to: toMeta.symbol,
      exchange: labelForPoolId(h.poolId),
      swapAmount: p.amountIn,
      amountOut: i === route.length - 1 ? amountOut : undefined,
      fromName: fromMeta.symbol,
      fromDecimals: fromMeta.decimals,
      toDecimals: toMeta.decimals,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Build.
 * ------------------------------------------------------------------ */

// viem ContractFunctionExecutionError.message is a multi-line dump (URL,
// request body, docs, version). The first line is the useful bit for the
// execution-panel banner; the full error is logged by the caller.
function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split(/\r?\n/, 1)[0]!.trim() || "unknown error";
}

// Builds a BuildPayload (kind "tx") ready for <SendTx>, including the
// client-side allowance check + approve tx. Throws with a clear message on
// failure (the caller surfaces it like a postBuild error).
export async function buildCurve(p: {
  chainId: number;
  chainMeta: {
    chainId: number;
    name: string;
    explorer: string;
    nativeSymbol: string;
  };
  tokenIn: { address: string; symbol: string; decimals: number };
  tokenOut: { address: string; symbol: string; decimals: number };
  amountIn: string; // base units
  slippageBps: number;
  sender: string;
  // Connected wallet's EIP-1193 provider when it sits on this chain — same
  // rule as balance reads. Never window.ethereum (wrong extension / prompt).
  walletProvider?: EIP1193Provider;
}): Promise<BuildPayload> {
  if (!curveSupportedChain(p.chainId)) {
    throw new Error(`curve: chain ${p.chainId} not supported`);
  }
  const ready = await warmCurve(p.chainId);
  if (!ready) {
    throw new Error("curve: client not ready (init failed)");
  }

  const curve = await loadCurve();
  const amountHuman = baseToHuman(p.amountIn, p.tokenIn.decimals);

  // Re-quote fresh for the amountOut shown to the user — the cached round is
  // stale by the time the user clicks build (contract O1). Both router calls
  // go through the serialization queue (see enqueueRouterCall): a round's
  // quote may be in flight when the user clicks build.
  const { route, output } = await enqueueRouterCall(
    () =>
      curve.router.getBestRouteAndOutput(
        p.tokenIn.address,
        p.tokenOut.address,
        amountHuman,
      ),
    "getBestRouteAndOutput (build)",
  );
  if (!route?.length) {
    throw new Error("curve: no route found at build time");
  }
  const amountOut = humanToBase(output, p.tokenOut.decimals).toString();

  // curve-js's slippage param is a percent (0.5 = 0.5%).
  const slippagePct = p.slippageBps / 100;
  const tx = await enqueueRouterCall(
    () =>
      curve.router.populateSwap(
        p.tokenIn.address,
        p.tokenOut.address,
        amountHuman,
        slippagePct,
      ),
    "populateSwap",
  );
  if (!tx.to || !tx.data) {
    throw new Error("curve: populateSwap returned no calldata");
  }
  const to = tx.to;
  const data = tx.data;
  const value = tx.value === undefined ? "0" : BigInt(tx.value).toString();

  // Allowance check — only for an ERC20 tokenIn. Native input needs none
  // (the value rides msg.value). RouterNG (tx.to) is the spender.
  //
  // Transport is publicClientFor: wallet provider (if authorized on this
  // chain) → CORS_OPEN_RPC → viem default. A bare `http()` used viem's
  // mainnet default (eth.merkle.io), which rejects browser origins and
  // rate-limits — the build then dumped the whole viem error into the UI.
  let approval: BuildPayload["approval"] = null;
  if (!isNative(p.tokenIn.address)) {
    const client = publicClientFor(p.chainId, p.walletProvider);
    if (!client) {
      throw new Error(`curve: no public client for chain ${p.chainId}`);
    }
    const required = BigInt(p.amountIn);
    let current: bigint;
    try {
      current = (await client.readContract({
        address: p.tokenIn.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "allowance",
        args: [p.sender as `0x${string}`, to as `0x${string}`],
      })) as bigint;
    } catch (err) {
      console.warn("curve client: allowance read failed", err);
      throw new Error(`curve: allowance read failed — ${shortError(err)}`);
    }
    const needed = current < required;
    approval = {
      needed,
      current: current.toString(),
      required: required.toString(),
      approveTx: needed
        ? {
            to: p.tokenIn.address,
            from: p.sender,
            // Exact-amount approve (not infinite) for minimum trust — same
            // policy as the CLI's allowance path.
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [to as `0x${string}`, required],
            }),
            value: "0",
            gas: null,
            gasPrice: null,
            maxPriorityFeePerGas: null,
            spender: to,
            chainId: p.chainId,
          }
        : null,
    };
  }

  return {
    kind: "tx",
    venue: "curve",
    chain: p.chainMeta,
    tokenIn: {
      address: p.tokenIn.address,
      symbol: p.tokenIn.symbol,
      decimals: p.tokenIn.decimals,
    },
    tokenOut: {
      address: p.tokenOut.address,
      symbol: p.tokenOut.symbol,
      decimals: p.tokenOut.decimals,
    },
    amountIn: p.amountIn,
    amountOut,
    sender: p.sender,
    recipient: null,
    slippageBps: p.slippageBps,
    approval,
    simulateEnabled: false,
    tx: {
      to,
      from: p.sender,
      data,
      value,
      gas: null,
      gasPrice: null,
      maxPriorityFeePerGas: null,
      spender: to,
      chainId: p.chainId,
    },
    order: null,
    permitTx: null,
    walletConnectProjectId: null,
  };
}

import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
} from "./types.ts";
import { UnsupportedChainError } from "./types.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { getRpcUrl } from "../rpc.ts";
import { fromBaseUnits } from "../amount.ts";

// Curve quote/build is delegated to @curvefi/api ("curve-js"). curve-js
// loads the same pool/factory graph the Curve UI uses (one HTTP GET per
// factory to api.curve.finance, ~1 s total) and exposes
// `router.getBestRouteAndOutput()` for multi-hop pathfinding +
// `router.populateSwap()` for unsigned RouterNG calldata. Replaces the
// earlier RateProvider-only implementation which only ever saw direct
// single-pool quotes and missed all crvUSD/factory-twocrypto routes.
//
// curve-js requires init per chain. We cache the initialized instance
// per chainId in a module-level map so repeated quotes within the same
// CLI invocation pay the ~1 s cost once.

import curveDefault from "@curvefi/api";

// curve-js's default export has a slightly funky type — its `init`
// signature uses `this: …` which TypeScript's type narrowing dislikes
// when called as a method. Cast to a permissive shape locally; we
// expose only the bits we actually use.
type CurveInstance = {
  chainId: number;
  init: (
    providerType: "JsonRpc",
    providerSettings: { url?: string; privateKey?: string; batchMaxCount?: number },
    options?: { chainId?: number },
  ) => Promise<void>;
  factory: { fetchPools: (useApi?: boolean) => Promise<void> };
  cryptoFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  stableNgFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  twocryptoFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  tricryptoFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  crvUSDFactory: { fetchPools: (useApi?: boolean) => Promise<void> };
  router: {
    getBestRouteAndOutput: (
      inputCoin: string,
      outputCoin: string,
      amount: string | number,
    ) => Promise<{
      route: Array<{
        poolId: string;
        swapAddress: string;
        inputCoinAddress: string;
        outputCoinAddress: string;
        swapParams: number[];
        poolAddress: string;
      }>;
      output: string;
    }>;
    populateSwap: (
      inputCoin: string,
      outputCoin: string,
      amount: string | number,
      slippage?: number,
    ) => Promise<{
      to?: string;
      data?: string;
      value?: bigint | string | number;
      from?: string;
      gasLimit?: bigint | number;
      maxFeePerGas?: bigint | number;
      maxPriorityFeePerGas?: bigint | number;
      gasPrice?: bigint | number;
    }>;
  };
};

const curve = curveDefault as unknown as CurveInstance;

// Curve has presence on these chains. Anything else throws
// UnsupportedChainError up the stack so it filters cleanly out of -v all.
// 137 (Polygon) deliberately excluded — verified 2026-09-09: curve-js
// router.getBestRouteAndOutput builds routes through the depegged MAI
// factory pools (0x447646e8…9308 metapool, 0x53c38755…83b2 plain) whose
// get_dy views show a phantom +18-27% "arb" that exchange() reverts on,
// and even the 1-hop atricrypto3 USDC.e→WETH route reverts under
// eth_simulateV1. Only StableNG↔StableNG routes execute. curve-js has no
// public router pool-blacklist (BLACK_LIST is inert on the API fetch
// path; EXCLUDED_POOLS_FROM_ROUTER is hardcoded), so re-enable only with
// a post-quote pool guard.
const CURVE_SUPPORTED_CHAIN_IDS = new Set([
  1, // Ethereum
  10, // Optimism — not in our chains.ts today but supported for future
  100, // Gnosis
  146, // Sonic
  250, // Fantom
  324, // zkSync
  8453, // Base
  42161, // Arbitrum
  43114, // Avalanche
]);

// One-time init guard per chain. curve-js's default singleton instance
// can only hold state for one chain at a time, so each chain switch
// requires a re-init + factory re-fetch. The promise stored here is
// awaited by every concurrent quote so we don't re-init mid-flight.
const initLocks = new Map<number, Promise<void>>();

// curve-js initializes an ethers v6 JsonRpcProvider internally. ethers
// providers register a block-poll timer (FetchRequest / poller) that
// keeps the event loop alive even after we're done — the CLI hangs
// after printing its result instead of exiting. Track whether init has
// run so `cleanup()` can destroy the provider on shutdown.
let initialized = false;

// curve-js's route-graph worker writes "Read N pools …, routerGraph: N
// items" to stdout from inside a Web Worker. Worker globals don't
// inherit our main-thread console.log monkey-patch in `ensureInit`, so
// we have to silence the worker at construction time. curve-js builds
// its workers via `new Blob([code], { type: 'application/javascript' })`
// then `URL.createObjectURL(blob)` then `new Worker(url)`. We patch
// `Blob` to detect the worker payload (matched by a curve-js-specific
// marker that no other library is going to emit) and prepend a console
// silencer to the source. Done once at module load.
let blobPatched = false;
function installCurveWorkerSilencer(): void {
  if (blobPatched) return;
  blobPatched = true;
  const RealBlob = globalThis.Blob;
  const SILENCER = "console.log=function(){};console.info=function(){};\n";
  const MARKERS = ["routeFinderWorker", "routeGraphWorker"];
  globalThis.Blob = new Proxy(RealBlob, {
    construct(target, args: [BlobPart[], BlobPropertyBag?]) {
      const [parts, opts] = args;
      const isJs =
        opts?.type?.toLowerCase().includes("javascript") ||
        opts?.type?.toLowerCase().includes("ecmascript");
      if (
        isJs &&
        Array.isArray(parts) &&
        parts.length > 0 &&
        typeof parts[0] === "string" &&
        MARKERS.some((m) => (parts[0] as string).includes(m))
      ) {
        return Reflect.construct(
          target,
          [[SILENCER, ...parts], opts],
          target,
        );
      }
      return Reflect.construct(target, args, target);
    },
  });
}
installCurveWorkerSilencer();

async function ensureInit(chainId: number, rpcUrl: string): Promise<void> {
  if (curve.chainId === chainId) return;
  let lock = initLocks.get(chainId);
  if (lock) return lock;
  lock = (async () => {
    // curve-js's init + router prints chatty banners
    // ("CURVE-JS IS CONNECTED TO NETWORK", "Read N pools…") to console.log.
    // Silence them — venue adapters should be quiet by default and the
    // user's terminal is already crowded with the streaming progress
    // block. We restore the original log on a finally so other code that
    // legitimately wants console.log still works.
    const realLog = console.log;
    console.log = () => {};
    try {
      await curve.init(
        "JsonRpc",
        { url: rpcUrl, batchMaxCount: 10 },
        { chainId },
      );
      // Pull every factory in parallel — one HTTP GET each to
      // api.curve.finance. Errors on individual factories (e.g. crvUSD
      // only on mainnet) are tolerated; curve-js no-ops when the alias
      // isn't present.
      await Promise.allSettled([
        curve.factory.fetchPools(),
        curve.cryptoFactory.fetchPools(),
        curve.stableNgFactory.fetchPools(),
        curve.twocryptoFactory.fetchPools(),
        curve.tricryptoFactory.fetchPools(),
        curve.crvUSDFactory.fetchPools(),
      ]);
    } finally {
      console.log = realLog;
    }
    initialized = true;
  })();
  initLocks.set(chainId, lock);
  try {
    await lock;
  } finally {
    initLocks.delete(chainId);
  }
}

// Tear down curve-js's ethers provider. Called from index.ts on the
// way out so the CLI doesn't hang on the provider's polling timer.
export async function cleanup(): Promise<void> {
  if (!initialized) return;
  const provider = (curve as unknown as { provider?: { destroy?: () => void } })
    .provider;
  try {
    provider?.destroy?.();
  } catch (err) {
    console.error(
      `curve cleanup: provider.destroy() failed — ${(err as Error).message}`,
    );
  }
  initialized = false;
}

// curve-js takes amounts as human-unit strings ("1000000" for 1M USDC).
// fromBaseUnits already gives a JS number-string with full precision —
// good enough to round-trip back via curve-js's internal BigNumber.
function toHumanAmount(raw: bigint, decimals: number): string {
  return fromBaseUnits(raw.toString(), decimals, decimals);
}

// curve-js sometimes hands us native ETH as the zero-address sentinel
// instead of our 0xeee… sentinel. Normalize before display.
function normalizeNative(addr: string): string {
  const a = addr.toLowerCase();
  if (
    a === "0x0000000000000000000000000000000000000000" ||
    a === NATIVE_SENTINEL
  ) {
    return NATIVE_SENTINEL;
  }
  return a;
}

type CurveBuildHint = {
  inputCoin: string; // for populateSwap (curve-js uses its own native sentinel)
  outputCoin: string;
  amountHuman: string;
};

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn, tokenInDecimals } = params;

  if (!CURVE_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("curve", chain.displayName);
  }

  const rpc = getRpcUrl(chain);
  await ensureInit(chain.chainId, rpc);

  // curve-js accepts both 0xeee… and 0x000…0 as native; pass whatever the
  // caller gave us through unchanged. Same for the output side.
  const inputCoin = tokenIn;
  const outputCoin = tokenOut;
  const amountHuman = toHumanAmount(amountIn, tokenInDecimals);

  // getBestRouteAndOutput also prints a "Read N pools" line to console.log.
  // Same silence treatment as init.
  const realLog = console.log;
  console.log = () => {};
  let route: Awaited<
    ReturnType<typeof curve.router.getBestRouteAndOutput>
  >["route"];
  let output: string;
  try {
    ({ route, output } = await curve.router.getBestRouteAndOutput(
      inputCoin,
      outputCoin,
      amountHuman,
    ));
  } finally {
    console.log = realLog;
  }

  if (!route?.length) {
    throw new Error(`curve: no route found for this pair`);
  }

  // Compute the raw amount_out from the human-format string output. We
  // multiply through to preserve precision (curve-js sometimes returns
  // long fractional strings like "418.49156725541576033").
  const amountOutRaw = humanToBaseUnits(output, params.tokenOutDecimals);

  // Map curve-js hops into our NormalizedHop shape. Each hop carries
  // poolId (e.g. "factory-crvusd-0") which we surface in `exchange` so
  // the route tree shows the right venue.
  const hops: NormalizedHop[] = route.map((h, i) => {
    const poolKind = labelForPoolId(h.poolId);
    const swapAmount =
      i === 0 ? amountIn.toString() : "0"; // intermediate amounts unknown
    return {
      tokenIn: normalizeNative(h.inputCoinAddress),
      tokenOut: normalizeNative(h.outputCoinAddress),
      exchange: poolKind,
      swapAmount,
      // Curve routes are linear (no splits), so the last hop's output is the
      // route output; intermediate hop outputs aren't exposed by curve-js.
      amountOut: i === route.length - 1 ? amountOutRaw.toString() : undefined,
      pool: h.poolAddress || h.swapAddress,
    };
  });

  // For the build path we pass the same triple back to populateSwap.
  const raw: CurveBuildHint = {
    inputCoin,
    outputCoin,
    amountHuman,
  };

  return {
    venue: "curve",
    amountIn: amountIn.toString(),
    amountOut: amountOutRaw.toString(),
    amountInUsd: null,
    amountOutUsd: null,
    // curve-js has no quote-time gas estimate. src/gas_usd.ts synthesizes
    // gasUnits from route shape for display.
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: route[0]?.swapAddress ?? null,
    hops,
    tokenHints: new Map(),
    raw,
  };
}

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, sender, slippageBps, quote } = params;

  if (!CURVE_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("curve", chain.displayName);
  }
  const rpc = getRpcUrl(chain);
  await ensureInit(chain.chainId, rpc);

  const hint = quote.raw as CurveBuildHint | undefined;
  if (!hint?.inputCoin) {
    throw new Error(
      "curve build: quote.raw missing — quote() didn't run via curve-js",
    );
  }

  // curve-js's slippage param is a percent (0.5 = 0.5%, default 0.5).
  const slippagePct = slippageBps / 100;

  // populateSwap, like getBestRouteAndOutput / init, logs its arguments
  // ("<in> <out> <amount> <slippage>") straight to console.log. Left
  // unsilenced this line lands on **stdout** and corrupts `--json`
  // output (and any downstream JSON consumer). Same silence treatment.
  const realLog = console.log;
  console.log = () => {};
  let tx: Awaited<ReturnType<typeof curve.router.populateSwap>>;
  try {
    tx = await curve.router.populateSwap(
      hint.inputCoin,
      hint.outputCoin,
      hint.amountHuman,
      slippagePct,
    );
  } finally {
    console.log = realLog;
  }

  if (!tx.to || !tx.data) {
    throw new Error("curve build: populateSwap returned no calldata");
  }

  const valueRaw =
    tx.value === undefined ? "0" : BigInt(tx.value).toString();

  return {
    to: tx.to,
    from: sender,
    data: tx.data,
    value: valueRaw,
    gas: tx.gasLimit !== undefined ? BigInt(tx.gasLimit).toString() : null,
    gasPrice:
      tx.gasPrice !== undefined ? BigInt(tx.gasPrice).toString() : null,
    maxPriorityFeePerGas:
      tx.maxPriorityFeePerGas !== undefined
        ? BigInt(tx.maxPriorityFeePerGas).toString()
        : null,
    spender: tx.to,
    chainId: chain.chainId,
  };
}

// Convert a human-decimal string (e.g. "418.49156725541576033") to its
// raw bigint with `decimals` places. Truncates beyond `decimals` rather
// than rounding — matches what RouterNG would actually return.
function humanToBaseUnits(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  const dot = trimmed.indexOf(".");
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const frac = dot === -1 ? "" : trimmed.slice(dot + 1);
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (
    BigInt(whole || "0") * 10n ** BigInt(decimals) +
    BigInt(fracPadded || "0")
  );
}

function labelForPoolId(poolId: string): string {
  // poolId examples: "3pool", "tricrypto2", "factory-crvusd-0",
  // "factory-twocrypto-316", "factory-stable-ng-12", etc. We surface a
  // human-friendly category for the route-tree display.
  if (poolId.startsWith("factory-stable-ng")) return "Curve StableSwap NG";
  if (poolId.startsWith("factory-twocrypto")) return "Curve TwoCrypto NG";
  if (poolId.startsWith("factory-tricrypto")) return "Curve TriCrypto NG";
  if (poolId.startsWith("factory-crvusd")) return "Curve crvUSD pool";
  if (poolId.startsWith("factory-crypto")) return "Curve Factory Crypto";
  if (poolId.startsWith("factory-")) return "Curve Factory Stable";
  return `Curve ${poolId}`;
}

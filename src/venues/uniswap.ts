import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  Eip712TypedData,
  NormalizedHop,
  NormalizedPermitTx,
  NormalizedQuote,
  NormalizedTx,
} from "./types.ts";
import { MissingApiKeyError, UnsupportedChainError } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { toChecksumAddress } from "../checksum.ts";

// Uniswap classic (v2/v3/v4) sync venue. Uses the Trading API for
// pricing and routing (`protocols: ["V2","V3","V4"]` pins CLASSIC AMM
// routes), then hand-builds the calldata against the appropriate
// periphery router based on the route shape — **only for EXACT_INPUT
// (side=sell)**:
//
//   - V3 single-hop  → SwapRouter02.exactInputSingle (no Permit2)
//   - V2 single-hop  → UniswapV2Router02.swapExactTokensForTokens
//   - V3 multi-hop / V2 multi-hop / V4 / mixed → Path A (/v1/swap)
//
// EXACT_OUTPUT (side=buy): always Path A. The hand-rolled fast path only
// encodes exactInput* / swapExactTokensForTokens. Reusing it for a buy
// would lock in the wrong trade direction (exact-in calldata for an
// exact-out quote) — critical bug. Trading API /v1/swap encodes the
// correct exact-output Universal Router commands + Permit2 when needed.
//
// Spender for the V3 sell fast path is SwapRouter02 (direct ERC20
// approve), for V2 sell UniswapV2Router02. Path A spender is Permit2.
//
// uniswapx remains a separate (async/intent) venue.

const UNISWAP_QUOTE_URL = "https://trade-api.gateway.uniswap.org/v1/quote";
const UNISWAP_SWAP_URL = "https://trade-api.gateway.uniswap.org/v1/swap";

// Permit2 — fixed deterministic deploy on every supported chain. This is
// the spender for ERC20 approvals on the V4 / split / mixed-route path
// (Universal Router pulls funds from Permit2 via the user's signature).
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// SwapRouter02 (Uniswap v3 periphery) — accepts direct ERC20 allowance,
// no Permit2 required. Same address on mainnet + arbitrum, different on
// base + bsc.
const SWAP_ROUTER_02: Record<number, string> = {
  1: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  10: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  42161: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  8453: "0x2626664c2603336E57B271c5C0b26F421741e481",
  56: "0x1B81D678ffb9C0263b24A97847620C99d213eB14",
};

// UniswapV2Router02 — mainnet only (v2 wasn't widely deployed elsewhere).
const V2_ROUTER: Record<number, string> = {
  1: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
};

// Subset of https://api-docs.uniswap.org/guides/supported_chains we
// actually expose via `chains.ts`. Adding a new chain here is enough
// to enable Path A (Permit2 sign + /v1/swap assemble) — the fast path
// (SwapRouter02 / V2Router02) only kicks in when the router address
// is also mapped above; otherwise canHandRoll falls through.
//
// 4663 (Robinhood) is deliberately NOT in SWAP_ROUTER_02 / V2_ROUTER:
// no official Uniswap-published periphery addresses for this chain were
// found, and the wrap short-circuit + thin native-ETH liquidity mean
// most 4663 routes are ERC20→ERC20 anyway. Leaving it unmapped routes
// every build through the Trading API /v1/swap (Path A), which returns
// the correct Universal Router calldata — correctness over a hand-rolled
// fast path we can't verify.
// 143 (Monad) is Path A only: no SwapRouter02 / V2_ROUTER mapping.
// 137 (Polygon) and 57073 (Ink) are Path A only: both have Uniswap v2/v3/v4
// deployed, but we have not verified official SwapRouter02 / V2Router02
// addresses for these chains in this repo, so builds go through /v1/swap.
// 5042 (Arc) is Path A only: every route we saw is a Uniswap v4 pool, which
// has no SwapRouter02 / V2Router02 to hand-roll against anyway.
// Arc quote accuracy, observed 2026-09-16: for ~15 minutes the Trading API
// quoted USDC→EURC through a DRAINED v4 pool (fee 375 / tickSpacing 4, id
// 0xc6e1605e…0f30) at the market rate; the built tx then reverts with
// V4TooLittleReceived — the min-out guard holds, so only gas is lost, never
// funds. Later quotes moved to a V3 0.05% pool / the v4 0.05% pool and
// execute fine. KyberSwap routes the same v4 liquidity with on-chain-accurate
// quotes, so the divergence is the Trading API's routing state, not the pool
// data. Venue kept (it wins plenty of Arc routes); `--simulate` is the safety
// net on this chain — it catches the stale-pool quote before broadcast.
const SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 42161, 8453, 56, 130, 137, 143, 43114, 4663, 57073, 5042,
]);

const SEL_EXACT_INPUT_SINGLE = "0x04e45aaf"; // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
const SEL_EXACT_INPUT = "0xb858183f"; // exactInput((bytes,address,uint256,uint256))
const SEL_V2_SWAP_EXACT_TOKENS = "0x38ed1739"; // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)

type RouteHop = {
  type: string; // "v3-pool" | "v2-pool" | "v4-pool" | …
  address: string;
  fee?: string;
  tokenIn?: { address: string; symbol?: string };
  tokenOut?: { address: string; symbol?: string };
  amountIn?: string;
  amountOut?: string;
  // V4-only fields. `hooks` is the deployed hook contract (zero address
  // = no hook). `fee = 0x800000` (8388608) is V4's dynamic-fee sentinel:
  // the hook computes the fee per swap, and the numeric `fee` is a
  // placeholder rather than the actual rate.
  hooks?: string;
  tickSpacing?: string;
};

const V4_DYNAMIC_FEE_FLAG = 0x800000; // 8388608

function formatV4Exchange(hop: RouteHop): string {
  const feeNum = hop.fee ? Number(hop.fee) : NaN;
  const isDynamic = feeNum === V4_DYNAMIC_FEE_FLAG;
  const hasHook =
    !!hop.hooks &&
    hop.hooks.toLowerCase() !== "0x0000000000000000000000000000000000000000";
  const feeLabel = Number.isFinite(feeNum)
    ? isDynamic
      ? "dynamic"
      : `${(feeNum / 10000).toFixed(2)}%`
    : null;
  const hookSuffix = hasHook ? " +hook" : "";
  return feeLabel
    ? `Uniswap V4 (${feeLabel}${hookSuffix})`
    : `Uniswap V4${hookSuffix ? ` (${hookSuffix.trim()})` : ""}`;
}

type ClassicQuote = {
  chainId: number;
  swapper: string;
  tradeType: string;
  route: RouteHop[][]; // outer: split paths; inner: sequential hops
  input: { amount: string; token: string };
  output: { amount: string; token: string };
  slippage: number;
  gasFee?: string;
  gasFeeUSD?: string;
  gasUseEstimate?: string;
  quoteId?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

// Permit2 PermitSingle EIP-712 typed data attached to every classic
// quote. We surface it as the typedData the user signs on the
// /v1/swap (Path A) flow.
type ClassicPermitData = {
  domain: Record<string, string | number>;
  types: Record<string, Array<{ name: string; type: string }>>;
  values: Record<string, unknown>;
};

type ClassicResponse = {
  quote?: ClassicQuote;
  permitData?: ClassicPermitData;
  routing?: string;
  errorCode?: string;
  detail?: string;
};

type SwapResponse = {
  swap?: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId: number;
    gasLimit?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
  };
  errorCode?: string;
  detail?: string;
};

// Stored on quote.raw so buildTx() can produce typedData for signing
// (V4 / split / mixed) and assemble() can re-call /v1/swap with the same
// quote+permitData the user signed against. Including a fresh quote
// would invalidate the signature (different nonces / amounts).
type UniswapRaw = {
  quote: ClassicQuote;
  permitData: ClassicPermitData | null;
  routing: string;
};

function pad32Addr(a: string): string {
  return a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function pad32Big(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

// Shared /v1/quote call used by both the initial quote and the build
// re-quote (the latter passes the real sender so permitData binds to
// them). Returns the full UniswapRaw triple ready to be stored on
// NormalizedQuote.raw.
// Native token at the API boundary: the Trading API's canonical native
// representation is the zero address (V4 PoolKey currency). It happens to
// also accept our 0xEee… sentinel on chains with V2/V3 WETH pools (mainnet),
// but NOT on V4-only chains — on Robinhood (4663) the sentinel 404s with
// ResourceNotFound while the zero address quotes fine. Both give identical
// results on mainnet, so always send zero. The response side already maps
// zero-address hop endpoints back to NATIVE_SENTINEL (normHopAddr).
function toApiAddress(addr: string): string {
  return addr.toLowerCase() === NATIVE_SENTINEL
    ? "0x0000000000000000000000000000000000000000"
    : toChecksumAddress(addr);
}

async function fetchClassicQuote(args: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** Required when side=buy — fixed tokenOut amount. */
  amountOut?: bigint;
  side?: "sell" | "buy";
  slippageBps: number;
  swapper: string;
}): Promise<UniswapRaw> {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("uniswap", "UNISWAP_API_KEY");
  const side = args.side ?? "sell";
  const isBuy = side === "buy";
  if (isBuy) {
    if (args.amountOut == null || args.amountOut <= 0n) {
      throw new Error("uniswap: side=buy requires a positive amountOut");
    }
  } else if (args.amountIn <= 0n) {
    throw new Error("uniswap: side=sell requires a positive amountIn");
  }
  // Trading API: `amount` is the fixed leg — tokenIn for EXACT_INPUT,
  // tokenOut for EXACT_OUTPUT. slippageTolerance is still percent; the
  // API applies it to the variable leg (minOut on sell, maxIn on buy).
  const body = {
    type: (isBuy ? "EXACT_OUTPUT" : "EXACT_INPUT") as
      | "EXACT_INPUT"
      | "EXACT_OUTPUT",
    tokenInChainId: args.chain.chainId,
    tokenOutChainId: args.chain.chainId,
    tokenIn: toApiAddress(args.tokenIn),
    tokenOut: toApiAddress(args.tokenOut),
    amount: isBuy ? args.amountOut!.toString() : args.amountIn.toString(),
    swapper: toChecksumAddress(args.swapper),
    slippageTolerance: args.slippageBps / 100,
    protocols: ["V2", "V3", "V4"],
  };
  const res = await venueFetch(UNISWAP_QUOTE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const json = await parseJsonOrWarn<ClassicResponse>(res, "uniswap /quote");
  if (!res.ok || !json.quote) {
    const reason =
      json.detail ?? json.errorCode ?? `${res.status} ${res.statusText}`;
    throw new Error(`uniswap: ${reason}`);
  }
  if (!json.quote.route?.length || !json.quote.route[0]?.length) {
    throw new Error(`uniswap: empty route in quote response`);
  }
  return {
    quote: json.quote,
    permitData: json.permitData ?? null,
    routing: json.routing ?? "CLASSIC",
  };
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** Fixed receive amount when side=buy. */
  amountOut?: bigint;
  side?: "sell" | "buy";
  slippageBps: number;
}): Promise<NormalizedQuote> {
  const {
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    side = "sell",
    slippageBps,
  } = params;

  if (!SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("uniswap", chain.displayName);
  }

  // Native ETH at quote-time is fine — the Trading API accepts the
  // zero address (toApiAddress maps our sentinel). Build forces Path A
  // for any native side since hand-rolled SwapRouter02 / V2Router02
  // calldata only handles ERC20→ERC20. Build also forces Path A for
  // side=buy (see buildTx).

  // Quote-time swapper placeholder. The build re-quotes with the real
  // sender; the swapper is baked into the response only as the recipient
  // of `quote.route[*].recipient`, which we override anyway.
  const swapperForQuote = "0x000000000000000000000000000000000000dEaD";

  const fresh = await fetchClassicQuote({
    chain,
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    side,
    slippageBps,
    swapper: swapperForQuote,
  });
  const q = fresh.quote;

  // Build hops for the route tree. Trading API can return multiple
  // parallel paths (split swap); we surface each hop. The display layer
  // groups by tokenIn so split swaps render as a tree node.
  //
  // Trading API quirk #1: only the first hop of each split path carries
  // `amountIn`; intermediates are null. Sister hops in any downstream
  // group all come from paths whose first-hop amountIn is denominated
  // in the user's input token, so using the path-entry amount as the
  // weight for every hop keeps the renderer's per-group ratio correct
  // (units cancel inside a group).
  //
  // Trading API quirk #2: V4 represents native ETH as the zero address
  // in PoolKey.currency, but the response still carries a `symbol`
  // field of "WETH" / `decimals: 18` for that side. Map zero-address
  // hop endpoints back to our NATIVE_SENTINEL so groups merge with the
  // canonical native sentinel and the renderer can label them.
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const normHopAddr = (a: string): string =>
    a.toLowerCase() === ZERO_ADDR ? NATIVE_SENTINEL : a.toLowerCase();
  let touchesNative = false;
  const hops: NormalizedHop[] = [];
  for (const path of q.route) {
    const pathEntry = path[0]?.amountIn ?? "0";
    for (const hop of path) {
      const inAddr = normHopAddr(hop.tokenIn?.address ?? tokenIn);
      const outAddr = normHopAddr(hop.tokenOut?.address ?? tokenOut);
      if (inAddr === NATIVE_SENTINEL || outAddr === NATIVE_SENTINEL) {
        touchesNative = true;
      }
      const exchange =
        hop.type === "v3-pool"
          ? `Uniswap V3${hop.fee ? ` (${(Number(hop.fee) / 10000).toFixed(2)}%)` : ""}`
          : hop.type === "v2-pool"
            ? "Uniswap V2"
            : hop.type === "v4-pool"
              ? formatV4Exchange(hop)
              : `Uniswap (${hop.type})`;
      hops.push({
        tokenIn: inAddr,
        tokenOut: outAddr,
        exchange,
        swapAmount: hop.amountIn ?? pathEntry,
        pool: hop.address,
      });
    }
  }
  // Seed a label for the native sentinel when any hop touches it, so
  // the route tree shows "ETH" / "AVAX" / etc. instead of the
  // shortened sentinel address. Goes through tokenHints so the
  // orchestrator's `intermediateAddrs` filter also skips this address
  // (no wasted KyberSwap lookup for the sentinel).
  const tokenHints = new Map<string, { symbol: string; name: string; decimals: number }>();
  if (touchesNative) {
    tokenHints.set(NATIVE_SENTINEL, {
      symbol: chain.nativeSymbol,
      name: chain.nativeSymbol,
      decimals: 18,
    });
  }

  // Gas: Trading API reports total wei (gasFee), USD (gasFeeUSD), and
  // unit estimate (gasUseEstimate). gasPriceWei = gasFee / gasUseEstimate
  // — match the renderer's "units @ gwei" format.
  const gasUnits = q.gasUseEstimate ? Number(q.gasUseEstimate) : null;
  const gasUsd = q.gasFeeUSD ? Number(q.gasFeeUSD) : null;
  const gasPriceWei =
    q.gasFee && gasUnits
      ? (BigInt(q.gasFee) / BigInt(gasUnits)).toString()
      : (q.maxFeePerGas ?? null);

  return {
    venue: "uniswap",
    amountIn: q.input.amount,
    amountOut: q.output.amount,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits,
    gasPriceWei,
    gasUsd,
    router: SWAP_ROUTER_02[chain.chainId] ?? null,
    hops,
    tokenHints,
    raw: fresh,
  };
}

export type UniswapBuildResult =
  | ({ kind: "tx" } & NormalizedTx)
  | NormalizedPermitTx;

export async function buildTx(
  params: BuildTxParams,
): Promise<UniswapBuildResult> {
  const {
    chain,
    tokenIn,
    tokenOut,
    sender,
    slippageBps,
    amountIn,
    amountOut: amountOutParam,
    quote,
    side = "sell",
  } = params;

  const raw = quote.raw as UniswapRaw | undefined;
  if (!raw?.quote.route?.[0]?.length) {
    throw new Error(`uniswap build: missing route in quote.raw`);
  }

  // Exact-out detection: honour explicit side=buy, and also fall back to
  // the quote's tradeType so a mis-plumbed caller still cannot hand-roll
  // exact-in calldata against an EXACT_OUTPUT route (critical).
  const tradeType = (raw.quote.tradeType ?? "").toUpperCase();
  const isExactOut =
    side === "buy" || tradeType === "EXACT_OUTPUT";

  // Hand-rolled fast path covers the common sell case (single path, pure
  // V2 or pure V3, ERC20→ERC20) without requiring a Permit2 signature —
  // the user just approves SwapRouter02 / V2Router02 directly and
  // broadcasts the tx. Anything else falls through to /v1/swap (Path A):
  // V4 / split / mixed needs a Permit2 PermitSingle (Universal Router
  // calldata), any native ETH side needs WRAP_ETH / UNWRAP_WETH, and
  // **buy / EXACT_OUTPUT must never reuse exactInput* / V2 exact-in
  // selectors** — force Path A so Trading API encodes exact-output.
  const isNativeIn = tokenIn.toLowerCase() === NATIVE_SENTINEL;
  const isNativeOut = tokenOut.toLowerCase() === NATIVE_SENTINEL;
  const isSinglePath = raw.quote.route.length === 1;
  const hops = raw.quote.route[0]!;
  const allV3 = isSinglePath && hops.every((h) => h.type === "v3-pool");
  const allV2 = isSinglePath && hops.every((h) => h.type === "v2-pool");
  // Only hand-roll when we have the relevant router address mapped
  // for this chain. On chains we support via the API but haven't
  // mapped a router for (e.g. Avalanche), fall through to Path A
  // (Universal Router via /v1/swap) instead of throwing.
  const canHandRoll =
    !isExactOut &&
    ((allV3 && SWAP_ROUTER_02[chain.chainId]) ||
      (allV2 && V2_ROUTER[chain.chainId])) &&
    !isNativeIn &&
    !isNativeOut;
  if (!canHandRoll) {
    // Re-quote with the real sender so permitData binds to them — the
    // original quote.raw was produced with the dEAD placeholder swapper
    // (the orchestrator's quote step doesn't always have a sender) and
    // its permitData would have the wrong nonce. Mutate the
    // orchestrator's NormalizedQuote.raw so the assemble step (which
    // reads quote.raw) sees the same quote+permitData the typedData
    // was derived from. Otherwise the signed message and the /v1/swap
    // inputs would diverge → revert on chain.
    //
    // Preserve EXACT_OUTPUT when re-quoting a buy: amount must stay the
    // fixed tokenOut, not the mid-quote amountIn.
    const fixedOut =
      amountOutParam != null && amountOutParam > 0n
        ? amountOutParam
        : BigInt(quote.amountOut);
    const fresh = await fetchClassicQuote({
      chain,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: isExactOut ? fixedOut : undefined,
      side: isExactOut ? "buy" : "sell",
      slippageBps,
      swapper: sender,
    });
    // Refresh the displayed amountIn/amountOut to match the fresh quote
    // the user is actually signing against. Without this, the summary
    // line printed after build() would show the original (placeholder)
    // quote's amounts while the signed Permit2 message references the
    // re-quoted ones. Warn when the *variable* leg moves more than the
    // user's slippage tolerance (amountOut on sell, amountIn on buy).
    if (isExactOut) {
      const oldIn = BigInt(quote.amountIn);
      const newIn = BigInt(fresh.quote.input.amount);
      if (oldIn > 0n) {
        const diff = newIn > oldIn ? newIn - oldIn : oldIn - newIn;
        const tolerance = (oldIn * BigInt(slippageBps)) / 10_000n;
        if (diff > tolerance) {
          const bps = Number((diff * 10_000n) / oldIn);
          console.error(
            `! uniswap re-quote moved ${bps} bps from displayed amountIn ` +
              `(${oldIn} → ${newIn}); maxAmountIn still bounded by ` +
              `--slippage but printed amountIn is the fresh one`,
          );
        }
      }
    } else {
      const oldOut = BigInt(quote.amountOut);
      const newOut = BigInt(fresh.quote.output.amount);
      if (oldOut > 0n) {
        const diff = newOut > oldOut ? newOut - oldOut : oldOut - newOut;
        const tolerance = (oldOut * BigInt(slippageBps)) / 10_000n;
        if (diff > tolerance) {
          const bps = Number((diff * 10_000n) / oldOut);
          console.error(
            `! uniswap re-quote moved ${bps} bps from displayed amount ` +
              `(${oldOut} → ${newOut}); minAmountOut still bounded by ` +
              `--slippage but printed amountOut is the fresh one`,
          );
        }
      }
    }
    quote.amountIn = fresh.quote.input.amount;
    quote.amountOut = fresh.quote.output.amount;
    quote.raw = fresh;
    if (!fresh.permitData) {
      // Native ETH input (or other no-permit paths) → no Permit2 sig
      // needed. Call /v1/swap immediately and return the broadcastable
      // tx — no two-step flow.
      const tx = await assemble({ chain, sender, quote });
      return { kind: "tx", ...tx };
    }
    return buildPermitTx({ chain, sender, raw: fresh });
  }

  const minOut =
    (BigInt(quote.amountOut) * BigInt(10_000 - slippageBps)) / 10_000n;

  // V3 routes → SwapRouter02. Single-hop uses exactInputSingle (static
  // struct, simple encoding). Multi-hop uses exactInput with a packed
  // path: tokenIn[20] + fee[3] + intermediate[20] + fee[3] + tokenOut[20]
  // …. No Permit2 — direct ERC20 approval to SwapRouter02.
  if (allV3) {
    const swapRouter = SWAP_ROUTER_02[chain.chainId];
    if (!swapRouter) {
      throw new Error(
        `uniswap build: SwapRouter02 not deployed on ${chain.displayName}`,
      );
    }
    if (hops.length === 1) {
      const hop = hops[0]!;
      const fee = parseInt(hop.fee ?? "3000", 10);
      const data =
        SEL_EXACT_INPUT_SINGLE +
        pad32Addr(tokenIn) +
        pad32Addr(tokenOut) +
        pad32Big(fee) +
        pad32Addr(sender) +
        pad32Big(amountIn) +
        pad32Big(minOut) +
        pad32Big(0); // sqrtPriceLimitX96 = 0 (unbounded)
      return {
        kind: "tx",
        to: swapRouter,
        from: sender,
        data,
        value: "0",
        gas: null,
        gasPrice: null,
        maxPriorityFeePerGas: null,
        spender: swapRouter,
        chainId: chain.chainId,
      };
    }
    // Multi-hop V3.
    let path = stripHex(tokenIn);
    for (const h of hops) {
      const fee = parseInt(h.fee ?? "3000", 10);
      path += fee.toString(16).padStart(6, "0");
      path += stripHex(h.tokenOut?.address ?? tokenOut);
    }
    const dataBytes = path.length / 2;
    const padded = path.padEnd(Math.ceil(path.length / 64) * 64, "0");
    // exactInput((bytes path, address recipient, uint amountIn, uint amountOutMin)).
    // Function takes a single dynamic tuple, so:
    //   selector | offset_to_tuple=0x20 | offset_to_bytes=0x80 |
    //   recipient | amountIn | amountOutMin | bytes_len | bytes_data padded
    const data =
      SEL_EXACT_INPUT +
      pad32Big(0x20) +
      pad32Big(0x80) +
      pad32Addr(sender) +
      pad32Big(amountIn) +
      pad32Big(minOut) +
      pad32Big(dataBytes) +
      padded;
    return {
      kind: "tx",
      to: swapRouter,
      from: sender,
      data,
      value: "0",
      gas: null,
      gasPrice: null,
      maxPriorityFeePerGas: null,
      spender: swapRouter,
      chainId: chain.chainId,
    };
  }

  // V2 routes → UniswapV2Router02.swapExactTokensForTokens with the full
  // path (single or multi-hop).
  const v2Router = V2_ROUTER[chain.chainId];
  if (!v2Router) {
    throw new Error(
      `uniswap build: UniswapV2Router02 not deployed on ${chain.displayName}`,
    );
  }
  const pathAddrs: string[] = [tokenIn];
  for (const h of hops) pathAddrs.push(h.tokenOut?.address ?? tokenOut);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 min
  // swapExactTokensForTokens(uint256, uint256, address[], address, uint256)
  // Layout:
  //   amountIn | amountOutMin | offset=0xa0 | to | deadline | len | addrs...
  let v2data =
    SEL_V2_SWAP_EXACT_TOKENS +
    pad32Big(amountIn) +
    pad32Big(minOut) +
    pad32Big(0xa0) +
    pad32Addr(sender) +
    pad32Big(deadline) +
    pad32Big(pathAddrs.length);
  for (const a of pathAddrs) v2data += pad32Addr(a);
  return {
    kind: "tx",
    to: v2Router,
    from: sender,
    data: v2data,
    value: "0",
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    spender: v2Router,
    chainId: chain.chainId,
  };
}

function stripHex(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(40, "0").slice(-40);
}

// Path A — V4 / split / mixed routes go through Trading API /v1/swap.
// We can't hand-roll Universal Router calldata locally because (a) V4
// routes need a PoolKey (currency0, currency1, fee, tickSpacing, hooks)
// that the API only references by ID, and (b) the calldata embeds a
// Permit2 signature, so we have to know the user's signature before
// final assembly. We surface the typedData here for the user to sign,
// then assemble() POSTs the signature back to /v1/swap.
function buildPermitTx(args: {
  chain: ChainInfo;
  sender: string;
  raw: UniswapRaw;
}): NormalizedPermitTx {
  const { chain, sender, raw } = args;
  if (!raw.permitData) {
    throw new Error(
      `uniswap build: route requires Permit2 signature but quote response had no permitData — re-quote and retry`,
    );
  }
  // EIP-712 typed data for wagmi/viem signTypedData. The Trading API's
  // permitData has `EIP712Domain` in `types`; signTypedData wants it
  // omitted. Primary type is whichever non-Domain key sits in the types
  // object (currently "PermitSingle" for ERC20→ERC20 and ERC20→ETH
  // routes).
  const typesWithoutDomain: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [k, v] of Object.entries(raw.permitData.types)) {
    if (k !== "EIP712Domain") typesWithoutDomain[k] = v;
  }
  const primaryType =
    Object.keys(typesWithoutDomain).find((k) =>
      // PermitSingle (top-level) carries the witness; PermitDetails is a
      // nested struct. Pick the one that references the others.
      typesWithoutDomain[k]!.some((f) => f.type !== "address" && f.type !== "uint256" && f.type !== "uint160" && f.type !== "uint48"),
    ) ?? "PermitSingle";
  const typedData: Eip712TypedData = {
    domain: raw.permitData.domain,
    types: typesWithoutDomain,
    primaryType,
    message: raw.permitData.values,
  };
  return {
    kind: "permit-tx",
    venue: "uniswap",
    spender: PERMIT2,
    signer: toChecksumAddress(sender),
    typedData,
    chainId: chain.chainId,
  };
}

// Second leg of the Path A flow. We hand (quote, permitData, signature)
// — or just `quote` for native ETH input where no Permit2 signature is
// needed — to /v1/swap, which embeds the signature into the Universal
// Router calldata and returns a ready-to-broadcast tx. permitData /
// quote MUST be the exact ones from the original /v1/quote that
// produced the signed typedData — using a fresh quote would
// invalidate the signature (different nonces / amounts).
export async function assemble(params: {
  chain: ChainInfo;
  sender: string;
  signature?: string;
  quote: NormalizedQuote;
}): Promise<NormalizedTx> {
  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("uniswap", "UNISWAP_API_KEY");
  const raw = params.quote.raw as UniswapRaw | undefined;
  if (!raw?.quote) {
    throw new Error(
      `uniswap assemble: quote.raw missing — was the quote produced by uniswap?`,
    );
  }
  const body: Record<string, unknown> = { quote: raw.quote };
  if (raw.permitData) {
    if (!params.signature) {
      throw new Error(
        `uniswap assemble: permitData present but no signature provided — sign typedData first`,
      );
    }
    body.permitData = raw.permitData;
    body.signature = params.signature;
  }
  const res = await venueFetch(UNISWAP_SWAP_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const json = await parseJsonOrWarn<SwapResponse>(res, "uniswap /swap");
  if (!res.ok || !json.swap) {
    const reason =
      json.detail ?? json.errorCode ?? `${res.status} ${res.statusText}`;
    throw new Error(`uniswap assemble: ${reason}`);
  }
  const swap = json.swap;
  return {
    to: swap.to,
    from: swap.from,
    data: swap.data,
    value: swap.value,
    gas: swap.gasLimit ?? null,
    gasPrice: swap.maxFeePerGas ?? null,
    maxPriorityFeePerGas: swap.maxPriorityFeePerGas ?? null,
    spender: PERMIT2,
    chainId: swap.chainId ?? params.chain.chainId,
  };
}

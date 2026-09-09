import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
  TokenHint,
} from "./types.ts";
import { MissingApiKeyError, UnsupportedChainError, toNumOrNull } from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { getReferralConfig } from "../referral.ts";

// 0x caps swapFeeBps at 1000 (10%) "for security"; going higher requires
// reaching out to 0x directly. Clamp like oneinch/openocean do so a
// misconfiguration degrades the fee instead of 0x rejecting the request.
// https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap
// ("swapFeeBps has a default limit of 1000 Bps for security", verified
// 2026-09-03). Coincides with referral.ts's own global REFERRAL_FEE_BPS cap
// today — clamped here too so the two staying in sync isn't load-bearing.
const MATCHA_FEE_BPS_MAX = 1000;

const ZEROEX_SUPPORTED_CHAIN_IDS = new Set([
  1, 10, 56, 130, 137, 143, 8453, 42161, 43114, 59144, 534352, 81457, 9745,
  4663, 57073,
]);

const ZEROEX_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

type ZeroexToken = { address: string; symbol: string };

type ZeroexFill = {
  source: string;
  proportionBps?: string | number;
  from?: string;
  to?: string;
};

type ZeroexRouteData = {
  tokens?: ZeroexToken[];
  fills?: ZeroexFill[];
};

/**
 * 0x v2 fee breakdown. Every response (price + quote, permit2 +
 * allowance-holder) carries a `fees` object whose three slots are each
 * `{amount, token, type}` or `null`:
 *
 *   - `integratorFee` — our own `swapFeeBps` cut (REFERRAL_FEE_BPS), denominated
 *     in `swapFeeToken` (we always ask for buyToken).
 *   - `zeroExFee` — 0x's own protocol cut, when their pricing applies one.
 *   - `gasFee` — gasless/relay flows only; never populated on our endpoints.
 *
 * `buyAmount` is ALREADY net of all of them (verified live 2026-08-09: a 50 bp
 * swapFee on a 10 WETH→USDC sell returned buyAmount 19_117_054_400 with
 * integratorFee.amount 96_065_611, summing back to the fee-free 19_213_1xx_xxx).
 * They are therefore informational only — never subtract them from amountOut.
 */
type ZeroexFee = { amount: string; token: string; type: string };
type ZeroexFees = {
  integratorFee?: ZeroexFee | null;
  zeroExFee?: ZeroexFee | null;
  gasFee?: ZeroexFee | null;
};

type ZeroexPriceResponse = {
  blockNumber?: string;
  buyAmount?: string;
  buyToken?: string;
  sellAmount?: string;
  sellToken?: string;
  gas?: string;
  gasPrice?: string;
  // SELL (exact-in) carries a single `route`; BUY (exact-out) splits into
  // `routes.forward` (the user's swap, same shape) + `routes.refund` (0x's
  // internal over-buy return path — not user-facing, ignored). Same shape on
  // allowance-holder/price and permit2/price (verified live 2026-07-15).
  route?: ZeroexRouteData;
  routes?: { forward?: ZeroexRouteData; refund?: ZeroexRouteData };
  // "exact-in" | "exact-out". Present in v2 responses.
  mode?: string;
  // Exact-out only: estimated sell amount (headline pay) + slippage ceiling.
  // `sellAmount` is undefined in exact-out mode.
  estimatedNetSellAmount?: string;
  maxSellAmount?: string;
  totalNetworkFee?: string;
  fees?: ZeroexFees;
  liquidityAvailable?: boolean;
  name?: string;
  message?: string;
};

function toZeroexAddr(addr: string): string {
  return addr.toLowerCase() === NATIVE_SENTINEL ? ZEROEX_NATIVE : addr.toLowerCase();
}

/**
 * Fold 0x's `fees` breakdown into a single `NormalizedQuote.protocolFee`.
 *
 * `zeroExFee` and `integratorFee` are summed when they land on the same token;
 * when they land on different ones we surface the tokenOut-side entry (the one
 * the renderer can express against `amountOut`) and log the other rather than
 * dropping it silently. A fee denominated in a third token (0x can bill in the
 * chain's native token on some routes) is logged and ignored — `protocolFee`
 * has no slot for it.
 *
 * `sharePct` = fee / the amount on the same side × 100 (kyber's convention).
 * Returns null when 0x charged nothing, which is the common case.
 */
export function parseMatchaFees(args: {
  fees: ZeroexFees | undefined;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
}): { raw: string; sharePct: number; side: "in" | "out" } | null {
  if (!args.fees) return null;
  const inAddr = toZeroexAddr(args.tokenIn);
  const outAddr = toZeroexAddr(args.tokenOut);

  type Entry = { label: string; amount: bigint; side: "in" | "out" | null; token: string };
  const entries: Entry[] = [];
  const slots: Array<[string, ZeroexFee | null | undefined]> = [
    ["zeroExFee", args.fees.zeroExFee],
    ["integratorFee", args.fees.integratorFee],
  ];
  for (const [label, f] of slots) {
    if (!f || !f.amount || !f.token) continue;
    let amount: bigint;
    try {
      amount = BigInt(f.amount);
    } catch (err) {
      console.error(
        `matcha: ignoring ${label} — unparseable amount ${JSON.stringify(f.amount)} (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      continue;
    }
    if (amount <= 0n) continue;
    const token = f.token.toLowerCase();
    const side = token === outAddr ? "out" : token === inAddr ? "in" : null;
    entries.push({ label, amount, side, token });
  }
  if (entries.length === 0) return null;

  // Prefer the tokenOut side — that's what the terminal / JSON renderers
  // express against amountOut, and it's where our own swapFee always lands.
  const side: "in" | "out" | null = entries.some((e) => e.side === "out")
    ? "out"
    : entries.some((e) => e.side === "in")
      ? "in"
      : null;
  if (side === null) {
    for (const e of entries) {
      console.error(
        `matcha: ${e.label} of ${e.amount} is denominated in ${e.token}, neither tokenIn nor tokenOut — not surfaced in protocolFee`,
      );
    }
    return null;
  }

  let raw = 0n;
  for (const e of entries) {
    if (e.side === side) {
      raw += e.amount;
    } else {
      console.error(
        `matcha: ${e.label} of ${e.amount} is denominated in ${e.token} (side ${e.side ?? "unknown"}), not the reported ${side} side — not included in protocolFee`,
      );
    }
  }
  if (raw <= 0n) return null;

  let base: bigint;
  try {
    base = BigInt(side === "in" ? args.amountIn : args.amountOut);
  } catch (err) {
    console.error(
      `matcha: cannot compute protocolFee sharePct — unparseable amount (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    base = 0n;
  }
  const sharePct = base > 0n ? Number((raw * 100_000_000n) / base) / 1_000_000 : 0;
  return { raw: raw.toString(), sharePct, side };
}

/**
 * Attach 0x monetization params (affiliate fee + trade surplus).
 *
 * - `tradeSurplusRecipient` — whenever `REFERRAL_ADDRESS` is set. Independent
 *   of `REFERRAL_FEE_BPS` / `--nofee` (same contract as velora `takeSurplus`).
 *   Honored only once 0x enables trade surplus on the API key (custom plan);
 *   otherwise 0x keeps surplus itself and the param is a no-op.
 * - `swapFee*` — only when address + feeBps > 0. Clamped to
 *   MATCHA_FEE_BPS_MAX. Fee on buyToken so it nets out of amountOut.
 */
function applyMatchaReferral(url: URL, buyToken: string): void {
  const ref = getReferralConfig();
  if (!ref.address) return;

  url.searchParams.set("tradeSurplusRecipient", ref.address);

  if (ref.feeBps > 0) {
    url.searchParams.set("swapFeeRecipient", ref.address);
    url.searchParams.set(
      "swapFeeBps",
      String(Math.min(ref.feeBps, MATCHA_FEE_BPS_MAX)),
    );
    url.searchParams.set("swapFeeToken", toZeroexAddr(buyToken));
  }
}

/** Exact-in (sell) vs exact-out (buy). Selects the 0x amount param + fields. */
export type MatchaSide = "sell" | "buy";

/**
 * 0x v2 amount param: SELL sends `sellAmount` (exact-in), BUY sends `buyAmount`
 * (exact-out). Same key on /price and /quote. 0x confirmed exact-out live
 * 2026-07-15 (mode:"exact-out", HTTP 200 on both allowance-holder + permit2).
 */
export function matchaAmountParam(opts: {
  side: MatchaSide;
  amountIn?: bigint;
  amountOut?: bigint;
}): { key: "sellAmount" | "buyAmount"; value: string } {
  if (opts.side === "buy") {
    if (opts.amountOut == null) throw new Error("matcha: side=buy requires amountOut");
    return { key: "buyAmount", value: opts.amountOut.toString() };
  }
  if (opts.amountIn == null) throw new Error("matcha: side=sell requires amountIn");
  return { key: "sellAmount", value: opts.amountIn.toString() };
}

/**
 * Map a 0x price response → display amounts by side.
 * - sell (exact-in): amountIn = echoed sellAmount, amountOut = buyAmount
 * - buy  (exact-out): amountOut = buyAmount (fixed target); amountIn =
 *   estimatedNetSellAmount (estimated pay — `sellAmount` is absent in this mode)
 */
export function normalizeMatchaQuoteAmounts(opts: {
  side: MatchaSide;
  sellAmount?: string;
  buyAmount: string;
  estimatedNetSellAmount?: string;
  /** Fallback for sell when the response omits sellAmount (echo of the request). */
  fallbackIn: bigint;
}): { amountIn: string; amountOut: string } {
  if (opts.side === "buy") {
    if (!opts.estimatedNetSellAmount) {
      throw new Error("matcha buy: response missing estimatedNetSellAmount");
    }
    return { amountIn: opts.estimatedNetSellAmount, amountOut: opts.buyAmount };
  }
  return {
    amountIn: opts.sellAmount ?? opts.fallbackIn.toString(),
    amountOut: opts.buyAmount,
  };
}

/** The user-facing route: `route` for SELL, `routes.forward` for BUY. */
export function matchaRouteForSide(
  json: { route?: ZeroexRouteData; routes?: { forward?: ZeroexRouteData } },
  side: MatchaSide,
): ZeroexRouteData | undefined {
  return side === "buy" ? json.routes?.forward : json.route;
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
  /** Exact-out receive amount (side=buy). */
  amountOut?: bigint;
  /** Defaults to "sell" (exact-in) for back-compat with the amountIn pipeline. */
  side?: MatchaSide;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn, slippageBps } = params;
  const side: MatchaSide = params.side ?? "sell";

  const apiKey = process.env.ZEROEX_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("matcha", "ZEROEX_API_KEY");

  if (!ZEROEX_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("matcha", chain.displayName);
  }

  const url = new URL("https://api.0x.org/swap/allowance-holder/price");
  url.searchParams.set("chainId", String(chain.chainId));
  url.searchParams.set("sellToken", toZeroexAddr(tokenIn));
  url.searchParams.set("buyToken", toZeroexAddr(tokenOut));
  // SELL → sellAmount (exact-in); BUY → buyAmount (exact-out).
  const amountParam = matchaAmountParam({ side, amountIn, amountOut: params.amountOut });
  url.searchParams.set(amountParam.key, amountParam.value);
  url.searchParams.set("slippageBps", String(slippageBps));
  applyMatchaReferral(url, tokenOut);

  const res = await venueFetch(url.toString(), {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
      accept: "application/json",
    },
  });

  const json = await parseJsonOrWarn<ZeroexPriceResponse>(res, "matcha /allowance-holder/price");

  if (!res.ok) {
    const reason = json.message || json.name || `${res.status} ${res.statusText}`;
    throw new Error(`matcha: ${reason}`);
  }

  if (json.liquidityAvailable === false || !json.buyAmount) {
    throw new Error(`matcha: no liquidity for this pair`);
  }

  const routeData = matchaRouteForSide(json, side);

  const tokenHints = new Map<string, TokenHint>();
  const routeTokens = routeData?.tokens ?? [];
  for (const t of routeTokens) {
    const lower = t.address.toLowerCase();
    if (t.symbol) {
      tokenHints.set(lower, { symbol: t.symbol, name: t.symbol, decimals: 18 });
    }
  }

  const norm = normalizeMatchaQuoteAmounts({
    side,
    sellAmount: json.sellAmount,
    buyAmount: json.buyAmount,
    estimatedNetSellAmount: json.estimatedNetSellAmount,
    fallbackIn: amountIn,
  });

  // Split weights are denominated in the ROUTE input token. For buy, amountIn
  // is a 0n placeholder from the dispatcher, so use the estimated sell amount
  // (normalized amountIn) as the split base instead.
  const splitBase = BigInt(norm.amountIn);
  const fills = routeData?.fills ?? [];
  const hops: NormalizedHop[] = [];
  const totalBps = fills.reduce(
    (a, f) => a + Number(f.proportionBps ?? 0),
    0,
  );
  for (const f of fills) {
    const fromAddr = (f.from ?? toZeroexAddr(tokenIn)).toLowerCase();
    const toAddr = (f.to ?? toZeroexAddr(tokenOut)).toLowerCase();
    const bps = Number(f.proportionBps ?? 0);
    const swap =
      totalBps > 0 && bps > 0
        ? ((splitBase * BigInt(bps)) / BigInt(totalBps)).toString()
        : splitBase.toString();
    hops.push({
      tokenIn: fromAddr === ZEROEX_NATIVE ? NATIVE_SENTINEL : fromAddr,
      tokenOut: toAddr === ZEROEX_NATIVE ? NATIVE_SENTINEL : toAddr,
      exchange: f.source,
      swapAmount: swap,
    });
  }

  return {
    venue: "matcha",
    amountIn: norm.amountIn,
    amountOut: norm.amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: toNumOrNull(json.gas),
    gasPriceWei: json.gasPrice ?? null,
    gasUsd: null,
    router: null,
    hops,
    tokenHints,
    // Informational only — `buyAmount` (hence amountOut) is already net of it.
    protocolFee: parseMatchaFees({
      fees: json.fees,
      tokenIn,
      tokenOut,
      amountIn: norm.amountIn,
      amountOut: norm.amountOut,
    }),
    raw: json,
  };
}

type ZeroexAllowanceQuoteResponse = {
  transaction?: {
    to: string;
    data: string;
    gas: string;
    gasPrice: string;
    value: string;
  };
  buyAmount?: string;
  // Same breakdown as /price. buildTx returns a NormalizedTx (which carries no
  // protocolFee slot), so it's declared for parity / debugging rather than
  // consumed — the displayed fee comes from the quote path above, and 0x is
  // sent the identical swapFee params on both endpoints.
  fees?: ZeroexFees;
  name?: string;
  message?: string;
};

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;
  const side: MatchaSide = params.side ?? "sell";

  const apiKey = process.env.ZEROEX_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("matcha", "ZEROEX_API_KEY");

  const url = new URL("https://api.0x.org/swap/allowance-holder/quote");
  url.searchParams.set("chainId", String(chain.chainId));
  url.searchParams.set("sellToken", toZeroexAddr(tokenIn));
  url.searchParams.set("buyToken", toZeroexAddr(tokenOut));
  // SELL fixes sellAmount; BUY fixes buyAmount (exact-out) and 0x ceils the
  // sell side to maxSellAmount via slippageBps.
  const amountParam = matchaAmountParam({ side, amountIn, amountOut: params.amountOut });
  url.searchParams.set(amountParam.key, amountParam.value);
  url.searchParams.set("taker", sender);
  url.searchParams.set("slippageBps", String(slippageBps));
  applyMatchaReferral(url, tokenOut);

  const res = await venueFetch(url.toString(), {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
      accept: "application/json",
    },
  });

  const json = await parseJsonOrWarn<ZeroexAllowanceQuoteResponse>(res, "matcha /allowance-holder/quote");
  if (!res.ok || !json.transaction) {
    throw new Error(
      `matcha build: ${json.message || json.name || `${res.status} ${res.statusText}`}`,
    );
  }

  const tx = json.transaction;
  return {
    to: tx.to,
    from: sender,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
    gasPrice: tx.gasPrice,
    maxPriorityFeePerGas: null,
    spender: tx.to,
    chainId: chain.chainId,
  };
}

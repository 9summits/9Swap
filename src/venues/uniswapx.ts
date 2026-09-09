import type { ChainInfo } from "../chains.ts";
import type {
  BuildTxParams,
  Eip712TypedData,
  NormalizedHop,
  NormalizedOrder,
  NormalizedQuote,
} from "./types.ts";
import {
  MissingApiKeyError,
  UnsupportedChainError,
} from "./types.ts";
import { parseJsonOrWarn, venueFetch } from "./http.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import { toChecksumAddress } from "../checksum.ts";

// Permit2 — deterministic deploy at this address on every supported chain.
// UniswapX orders are signed as Permit2 witnesses, so this is the spender
// that needs ERC20 approval (one-time, infinite).
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// UniswapX is live on these chains today. Keep the whitelist tight — the
// Trading API will reject the request when no UniswapX route exists for
// the pair/chain (we pin protocols to UNISWAPX_V2, so it cannot fall
// back to a CLASSIC route).
const UNISWAPX_SUPPORTED_CHAIN_IDS = new Set([1, 8453, 42161, 130]);

const UNISWAPX_QUOTE_URL = "https://trade-api.gateway.uniswap.org/v1/quote";
const UNISWAPX_SUBMIT_URL = "https://trade-api.gateway.uniswap.org/v1/order";

function rejectIfNative(addr: string, role: "tokenIn" | "tokenOut"): void {
  if (addr.toLowerCase() === NATIVE_SENTINEL) {
    throw new Error(
      `uniswapx does not support native ETH as ${role} — use the chain's wrapped native (WETH on mainnet/arb/base) and pass that address.`,
    );
  }
}

// As of 2026, the Trading API's `quote` envelope no longer carries
// `input`/`output` amount fields directly. The amounts live inside the
// EIP-712 witness in `permitData.values.witness`:
//   - input  = witness.baseInputStartAmount        (also = permitted.amount)
//   - output = witness.baseOutputs[0].startAmount  (recipient = swapper)
// The deadline / swapper / nonce all moved into `witness.info`.
type UniswapXDutchOutput = {
  token: string;
  startAmount: string;
  endAmount: string;
  recipient: string;
};

type UniswapXOrderInfo = {
  reactor: string;
  swapper: string;
  nonce: string;
  deadline: number;
  additionalValidationContract: string;
  additionalValidationData: string;
};

type UniswapXWitness = {
  info: UniswapXOrderInfo;
  cosigner: string;
  baseInputToken: string;
  baseInputStartAmount: string;
  baseInputEndAmount: string;
  baseOutputs: UniswapXDutchOutput[];
};

type UniswapXPermitData = {
  domain: Record<string, string | number>;
  types: Record<string, Array<{ name: string; type: string }>>;
  values: {
    permitted: { token: string; amount: string };
    spender: string;
    nonce: string;
    deadline: number;
    witness: UniswapXWitness;
  };
};

type UniswapXQuoteEnvelope = {
  orderId?: string;
  encodedOrder?: string;
  // Legacy fields still surface in some responses; try them as fallback.
  swapper?: string;
  deadline?: number;
  decayStartTime?: number;
  decayEndTime?: number;
};

type UniswapXQuoteResponse = {
  quote?: UniswapXQuoteEnvelope;
  permitData?: UniswapXPermitData;
  routing?: string;
  errorCode?: string;
  detail?: string;
};

// Pull the input/output amounts out of the quote response, accommodating
// both the modern Dutch V2/V3 shape (amounts in permitData.witness) and
// the older shape (amounts in quote.input/quote.output).
function readAmounts(json: UniswapXQuoteResponse): {
  amountIn: string;
  amountOut: string;
  swapper: string;
  deadline: number;
} | null {
  if (json.permitData?.values) {
    const values = json.permitData.values;
    const witness = values.witness;
    if (!witness?.baseOutputs?.length) return null;
    const amountIn =
      witness.baseInputStartAmount ?? values.permitted?.amount ?? null;
    const amountOut = witness.baseOutputs[0]!.startAmount;
    if (!amountIn || !amountOut) return null;
    return {
      amountIn,
      amountOut,
      swapper: witness.info.swapper,
      deadline: witness.info.deadline ?? values.deadline,
    };
  }
  // Legacy fallback — older Trading API revisions emit amounts on the
  // top-level quote envelope.
  const legacy = json.quote as unknown as
    | { input?: { amount?: string }; output?: { amount?: string } }
    | undefined;
  if (legacy?.input?.amount && legacy.output?.amount) {
    return {
      amountIn: legacy.input.amount,
      amountOut: legacy.output.amount,
      swapper: json.quote?.swapper ?? "",
      deadline: json.quote?.deadline ?? Math.floor(Date.now() / 1000) + 60,
    };
  }
  return null;
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
}): Promise<NormalizedQuote> {
  const { chain, tokenIn, tokenOut, amountIn, slippageBps } = params;

  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — the UniswapX Reactor unwraps WETH → ETH
  // at settlement when the order's outputToken is the native sentinel.
  // Pass it through unchanged.

  if (!UNISWAPX_SUPPORTED_CHAIN_IDS.has(chain.chainId)) {
    throw new UnsupportedChainError("uniswapx", chain.displayName);
  }

  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("uniswapx", "UNISWAP_API_KEY");

  // The Trading API quote phase requires the swapper address — used to
  // populate the order's `swapper` field in the returned permitData. With
  // no sender on the quote-only path we fall back to a placeholder address;
  // build() re-quotes with the real sender (since the permit's swapper
  // must equal the signer).
  const swapperForQuote = "0x000000000000000000000000000000000000dEaD";

  // Pin to UNISWAPX_V2 only. Forces the API to either return a Dutch V2
  // order or fail outright, so we never get a sync CLASSIC tx hidden
  // behind -v uniswapx. The Trading API schema rejects mixing
  // UNISWAPX_V2 + UNISWAPX_V3 in the same `protocols` array
  // ("value contains an invalid value"), and UNISWAPX_V3 alone returns
  // no quotes today — V2 is the only working option.
  const body = {
    type: "EXACT_INPUT" as const,
    tokenInChainId: chain.chainId,
    tokenOutChainId: chain.chainId,
    tokenIn: toChecksumAddress(tokenIn),
    tokenOut: toChecksumAddress(tokenOut),
    amount: amountIn.toString(),
    swapper: swapperForQuote,
    slippageTolerance: slippageBps / 100,
    protocols: ["UNISWAPX_V2"],
  };

  const res = await venueFetch(UNISWAPX_QUOTE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const json = await parseJsonOrWarn<UniswapXQuoteResponse>(
    res,
    "uniswapx /quote",
  );
  if (!res.ok || !json.quote) {
    const reason = json.detail ?? json.errorCode ?? `${res.status} ${res.statusText}`;
    throw new Error(`uniswapx: ${reason}`);
  }

  const routing = json.routing ?? "";
  const amounts = readAmounts(json);
  if (!amounts) {
    throw new Error(
      `uniswapx: response missing amounts (permitData.values.witness.baseInputStartAmount / baseOutputs[0].startAmount)`,
    );
  }
  const hops: NormalizedHop[] = []; // UniswapX doesn't expose hops at quote time.

  return {
    venue: "uniswapx",
    amountIn: amounts.amountIn,
    amountOut: amounts.amountOut,
    amountInUsd: null,
    amountOutUsd: null,
    // Filler pays gas — UniswapX's gasUseEstimate field describes the
    // classic-router fallback, not what the user signs. Render shows
    // "gas filler" instead.
    gasUnits: null,
    gasPriceWei: null,
    gasUsd: null,
    router: PERMIT2,
    hops,
    tokenHints: new Map(),
    raw: { ...json, _routing: routing },
  };
}

export async function buildOrder(
  params: BuildTxParams,
): Promise<NormalizedOrder> {
  const { chain, tokenIn, tokenOut, amountIn, sender, slippageBps } = params;

  rejectIfNative(tokenIn, "tokenIn");
  // tokenOut native is fine — the UniswapX Reactor unwraps WETH → ETH
  // at settlement when the order's outputToken is the native sentinel.
  // Pass it through unchanged.

  const apiKey = process.env.UNISWAP_API_KEY;
  if (!apiKey) throw new MissingApiKeyError("uniswapx", "UNISWAP_API_KEY");

  // Re-quote with the real swapper. UniswapX bakes swapper into the order
  // (it's the address whose Permit2 nonce is consumed); the typed-data
  // signature is bound to the message, so we can't re-use a placeholder
  // quote.
  const body = {
    type: "EXACT_INPUT" as const,
    tokenInChainId: chain.chainId,
    tokenOutChainId: chain.chainId,
    tokenIn: toChecksumAddress(tokenIn),
    tokenOut: toChecksumAddress(tokenOut),
    amount: amountIn.toString(),
    swapper: toChecksumAddress(sender),
    slippageTolerance: slippageBps / 100,
    protocols: ["UNISWAPX_V2"],
  };

  const res = await venueFetch(UNISWAPX_QUOTE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const json = await parseJsonOrWarn<UniswapXQuoteResponse>(
    res,
    "uniswapx build /quote",
  );
  if (!res.ok || !json.quote) {
    const reason = json.detail ?? json.errorCode ?? `${res.status} ${res.statusText}`;
    throw new Error(`uniswapx build: ${reason}`);
  }
  const q = json.quote;
  // permitData moved to the top level of the response in the modern
  // Trading API; older revisions kept it on the quote envelope. Look in
  // both places.
  const permitData =
    json.permitData ??
    (q as unknown as { permitData?: UniswapXPermitData }).permitData;
  if (!permitData) {
    throw new Error(
      `uniswapx build: response missing permitData — cannot construct EIP-712 order`,
    );
  }
  if (!q.encodedOrder) {
    throw new Error(
      `uniswapx build: response missing encodedOrder — cannot submit`,
    );
  }

  // permitData.values is the EIP-712 message; promote it to `message` to
  // match our NormalizedOrder shape. Prefer the explicit Permit2 primary
  // type over Object.keys order — nested structs (TokenPermissions,
  // V2DutchOrder, …) must never win if key order changes.
  const typesWithoutDomain: Record<
    string,
    Array<{ name: string; type: string }>
  > = {};
  for (const [k, v] of Object.entries(permitData.types)) {
    if (k !== "EIP712Domain") typesWithoutDomain[k] = v;
  }
  const primaryType =
    ("PermitWitnessTransferFrom" in typesWithoutDomain
      ? "PermitWitnessTransferFrom"
      : "PermitBatchWitnessTransferFrom" in typesWithoutDomain
        ? "PermitBatchWitnessTransferFrom"
        : Object.keys(typesWithoutDomain)[0]) ?? "PermitWitnessTransferFrom";

  const typedData: Eip712TypedData = {
    domain: permitData.domain,
    types: typesWithoutDomain,
    primaryType,
    message: permitData.values as unknown as Record<string, unknown>,
  };

  // Trading API /v1/order body is the quote response shape + signature
  // (not the legacy uniswapx-service {encodedOrder, orderType, chainId}
  // envelope). Docs: "identical to the quote response except for the
  // addition of the signed permit". `routing` stays the API's DUTCH_V2
  // enum (not OrderType.Dutch_V2).
  const routing = json.routing ?? "DUTCH_V2";
  const submitBody: Record<string, unknown> = {
    signature: null, // caller fills after signing
    routing,
    quote: q,
  };

  // Deadline now lives on the witness, not on the quote envelope.
  const deadline =
    permitData.values.witness?.info?.deadline ??
    permitData.values.deadline ??
    q.deadline ??
    Math.floor(Date.now() / 1000) + 60;

  return {
    kind: "order",
    venue: "uniswapx",
    spender: PERMIT2,
    signer: toChecksumAddress(sender),
    typedData,
    submit: {
      url: UNISWAPX_SUBMIT_URL,
      method: "POST",
      bodyTemplate: submitBody,
      // Browser / dApp must not hold the key; proxyOrderSubmit attaches it.
      auth: { kind: "api-key", envVar: "UNISWAP_API_KEY" },
    },
    orderHash: q.orderId,
    validUntilSec: deadline,
    decayStartSec: q.decayStartTime ?? null,
    chainId: chain.chainId,
  };
}

// Shape of the JSON the CLI's local server returns from GET /tx?id=…
// Mirrors src/browser.ts on the CLI side. Keep both in sync.

export type ChainMeta = {
  chainId: number;
  name: string;
  explorer: string;
  nativeSymbol: string;
};

export type TokenMeta = {
  address: string;
  symbol: string;
  decimals: number;
};

export type ApprovalInfo = {
  needed: boolean;
  current: string; // raw bigint string
  required: string;
  approveTx: SwapTx | null; // null when approval not needed
};

export type SwapTx = {
  to: string;
  from: string;
  data: string;
  value: string;
  gas: string | null;
  gasPrice: string | null;
  maxPriorityFeePerGas: string | null;
  spender: string;
  chainId: number;
};

export type Eip712TypedData = {
  domain: Record<string, string | number>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Wire shape returned by POST /simulate?id=<sid>. Mirrors
// SimulateOutcomeWire on the CLI side. Bigints come through as
// decimal strings (gas, tokenOutReceived).
export type SimulateOutcome =
  | {
      kind: "ok";
      approveStatus: "ok" | "reverted" | "skipped";
      approveGasUsed: string | null;
      swapStatus: "ok" | "reverted";
      swapGasUsed: string | null;
      swapRevertReason: string | null;
      tokenOutReceived: string;
      // USD per single token (multiply by human-units amount), not for
      // amountIn. Null when no Alchemy key, chain unsupported, or the
      // token isn't priced.
      tokenInPriceUsd: number | null;
      tokenOutPriceUsd: number | null;
    }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

export type SwapOrder = {
  venue: string; // "cow" | "uniswapx" | "delta" | "fusion"
  spender: string;
  signer: string;
  typedData: Eip712TypedData;
  submit: { url: string; method: "POST"; bodyTemplate: Record<string, unknown> };
  validUntilSec: number;
  decayStartSec: number | null;
  chainId: number;
};

// Sign-then-tx flow: user signs typedData (Permit2 PermitSingle for
// Uniswap), POSTs the signature to the local server's /assemble
// endpoint, server returns the broadcastable tx, page sends it.
// Used for Uniswap V4 / split / mixed routes.
export type SwapPermitTx = {
  venue: string; // "uniswap"
  spender: string;
  signer: string;
  typedData: Eip712TypedData;
  chainId: number;
};

export type Payload = {
  kind: "tx" | "order" | "permit-tx";
  venue: string;
  chain: ChainMeta;
  tokenIn: TokenMeta;
  tokenOut: TokenMeta;
  amountIn: string;
  amountOut: string;
  minAmountOut?: string;
  sender: string;
  // Set only for `-a send`. For ERC20 sends the recipient is encoded in
  // tx.data, so we surface it explicitly so the UI can show it without
  // re-decoding calldata.
  recipient: string | null;
  slippageBps: number;
  approval: ApprovalInfo | null;
  // True when the user invoked the CLI with --simulate / --simu. The
  // simulate panel only renders in that case, so a normal `--browser`
  // session ships a clean send/sign UI without the eth_simulateV1 noise.
  simulateEnabled: boolean;
  tx: SwapTx | null;
  order: SwapOrder | null;
  permitTx: SwapPermitTx | null;
  // Optional: WalletConnect project id (so the bundle picks it up at
  // runtime via <script>window.__WC_PROJECT_ID = …</script> rather than
  // requiring a build-time define).
  walletConnectProjectId: string | null;
  // Opaque context blob returned by /api/build for permit-tx routes; sent
  // back verbatim to /assemble so a stateless server can reconstruct the
  // Uniswap /v1/swap call without an in-memory session. Absent for tx/order.
  assembleContext?: unknown;
};

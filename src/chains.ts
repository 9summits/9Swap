export type ChainAlias =
  | "eth"
  | "arb"
  | "base"
  | "op"
  | "avax"
  | "bsc"
  | "hype"
  | "unichain"
  | "robinhood"
  | "arc"
  | "monad"
  | "plasma"
  | "polygon"
  | "gnosis"
  | "ink";

export type ChainInfo = {
  alias: ChainAlias;
  chainId: number;
  /** null = KyberSwap has no aggregator for this chain; the kyber adapter throws UnsupportedChainError */
  kyberPath: string | null;
  displayName: string;
  nativeSymbol: string;
  explorer: string;
  coingeckoPlatform: string;
  /** Subdomain under `.g.alchemy.com/v2/` for this chain. null = not supported by Alchemy. */
  alchemySubdomain: string | null;
  /** Canonical wrapped-native ERC20 (WETH9 or equivalent). When tokenIn/tokenOut
   *  match the native↔wrapped pair, swap short-circuits the venue loop and
   *  emits a direct deposit() / withdraw() tx — no venue quote, 1:1 rate.
   *  null = the chain has no WETH9-style wrapper (Arc), which disables the
   *  wrap/unwrap short-circuit entirely there. */
  wrappedNative: string | null;
  /** ERC20 that IS the native asset, for chains where the gas token is also a
   *  regular token rather than a sentinel-only balance (Arc: gas is USDC).
   *  When set:
   *    - the native symbol resolves to this address (builtin table decimals),
   *    - the curated token list does NOT prepend the synthetic 0xeee… entry,
   *    - resolving 0xeee… explicitly throws, pointing at this address.
   *  Arc exposes one balance under two decimals — 18 at the EVM level
   *  (msg.value / eth_getBalance / gas) and 6 through the ERC20 interface at
   *  0x3600…0000 — so the ERC20 view is the only one safe for calldata.
   *  null on every other chain (native = the 0xeee… sentinel, 18 decimals). */
  nativeErc20: string | null;
};

export const CHAINS: Record<ChainAlias, ChainInfo> = {
  eth: {
    alias: "eth",
    chainId: 1,
    kyberPath: "ethereum",
    displayName: "Ethereum",
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    coingeckoPlatform: "ethereum",
    alchemySubdomain: "eth-mainnet",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    nativeErc20: null,
  },
  base: {
    alias: "base",
    chainId: 8453,
    kyberPath: "base",
    displayName: "Base",
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
    coingeckoPlatform: "base",
    alchemySubdomain: "base-mainnet",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    nativeErc20: null,
  },
  // Robinhood Chain — Arbitrum-stack L2, native ETH.
  //   - kyberPath "robinhood" is KyberSwap's live aggregator path.
  //   - coingeckoPlatform "robinhood" is a real CoinGecko asset-platform
  //     id. KyberSwap ks-setting has no 4663 tokens, so the curated dApp
  //     list comes from src/tokens_builtin.ts.
  //   - alchemySubdomain is correct but the network is opt-in per Alchemy
  //     app (not enabled by default) — set ROBINHOOD_RPC_URL (or
  //     RPC_URL_4663) to the public RPC if Alchemy 404s the network.
  //   - wrappedNative verified on-chain (symbol/decimals/deposit/withdraw).
  robinhood: {
    alias: "robinhood",
    chainId: 4663,
    kyberPath: "robinhood",
    displayName: "Robinhood",
    nativeSymbol: "ETH",
    explorer: "https://robinhoodchain.blockscout.com",
    coingeckoPlatform: "robinhood",
    alchemySubdomain: "robinhood-mainnet",
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    nativeErc20: null,
  },
  // Arc (Circle's L1) — the gas token is USDC, not ETH.
  //   - Two decimals for ONE balance: 18 at the EVM level (msg.value,
  //     eth_getBalance, gas) but 6 through the ERC20 interface at
  //     0x3600…0000 (symbol/name/decimals verified on-chain). Circle's docs
  //     say to rely solely on the ERC20 view, so `nativeErc20` points at it
  //     and the 0xeee… sentinel is rejected on this chain.
  //   - No WETH9-style wrapper exists for native USDC → wrappedNative null,
  //     wrap/unwrap short-circuit disabled. The bridged "WETH"
  //     (0x128cC466…84EDB, Wrapped Ether, 18 dec) is bridged ETH, NOT a
  //     wrapper of the native asset — never use it here.
  //   - kyberPath "arc" verified live 2026-09-16 (aggregator + ks-setting
  //     both answer for 5042).
  //   - alchemySubdomain per docs.arc.io, but like robinhood the network is
  //     opt-in per Alchemy app — set ARC_RPC_URL (or RPC_URL_5042) to
  //     https://rpc.mainnet.arc.io if Alchemy 404s the network.
  arc: {
    alias: "arc",
    chainId: 5042,
    kyberPath: "arc",
    displayName: "Arc",
    nativeSymbol: "USDC",
    explorer: "https://explorer.arc.io",
    coingeckoPlatform: "arc",
    alchemySubdomain: "arc-mainnet",
    wrappedNative: null,
    nativeErc20: "0x3600000000000000000000000000000000000000",
  },
  hype: {
    alias: "hype",
    chainId: 999,
    kyberPath: "hyperevm",
    displayName: "HyperEVM",
    nativeSymbol: "HYPE",
    explorer: "https://hyperevmscan.io",
    coingeckoPlatform: "hyperevm",
    alchemySubdomain: "hyperliquid-mainnet",
    wrappedNative: "0x5555555555555555555555555555555555555555",
    nativeErc20: null,
  },
  // Ink — OP-stack L2, native ETH, WETH at 0x4200…0006.
  // KyberSwap has no aggregator (404); kyberPath null. ks-setting has 0
  // tokens, so the curated list comes from src/tokens_builtin.ts.
  ink: {
    alias: "ink",
    chainId: 57073,
    kyberPath: null,
    displayName: "Ink",
    nativeSymbol: "ETH",
    explorer: "https://explorer.inkonchain.com",
    coingeckoPlatform: "ink",
    alchemySubdomain: "ink-mainnet",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    nativeErc20: null,
  },
  arb: {
    alias: "arb",
    chainId: 42161,
    kyberPath: "arbitrum",
    displayName: "Arbitrum",
    nativeSymbol: "ETH",
    explorer: "https://arbiscan.io",
    coingeckoPlatform: "arbitrum-one",
    alchemySubdomain: "arb-mainnet",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    nativeErc20: null,
  },
  op: {
    alias: "op",
    chainId: 10,
    kyberPath: "optimism",
    displayName: "Optimism",
    nativeSymbol: "ETH",
    explorer: "https://optimistic.etherscan.io",
    coingeckoPlatform: "optimistic-ethereum",
    alchemySubdomain: "opt-mainnet",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    nativeErc20: null,
  },
  avax: {
    alias: "avax",
    chainId: 43114,
    kyberPath: "avalanche",
    displayName: "Avalanche",
    nativeSymbol: "AVAX",
    explorer: "https://snowtrace.io",
    coingeckoPlatform: "avalanche",
    alchemySubdomain: "avax-mainnet",
    wrappedNative: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    nativeErc20: null,
  },
  bsc: {
    alias: "bsc",
    chainId: 56,
    kyberPath: "bsc",
    displayName: "BNB Chain",
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    coingeckoPlatform: "binance-smart-chain",
    alchemySubdomain: "bnb-mainnet",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    nativeErc20: null,
  },
  unichain: {
    alias: "unichain",
    chainId: 130,
    kyberPath: "unichain",
    displayName: "Unichain",
    nativeSymbol: "ETH",
    explorer: "https://uniscan.xyz",
    coingeckoPlatform: "unichain",
    alchemySubdomain: "unichain-mainnet",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    nativeErc20: null,
  },
  monad: {
    alias: "monad",
    chainId: 143,
    kyberPath: "monad",
    displayName: "Monad",
    nativeSymbol: "MON",
    explorer: "https://monadvision.com",
    coingeckoPlatform: "monad",
    alchemySubdomain: "monad-mainnet",
    wrappedNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    nativeErc20: null,
  },
  plasma: {
    alias: "plasma",
    chainId: 9745,
    kyberPath: "plasma",
    displayName: "Plasma",
    nativeSymbol: "XPL",
    explorer: "https://plasmascan.to",
    coingeckoPlatform: "plasma",
    alchemySubdomain: "plasma-mainnet",
    wrappedNative: "0x6100E367285b01F48D07953803A2d8dCA5D19873",
    nativeErc20: null,
  },
  polygon: {
    alias: "polygon",
    chainId: 137,
    kyberPath: "polygon",
    displayName: "Polygon",
    nativeSymbol: "POL",
    explorer: "https://polygonscan.com",
    coingeckoPlatform: "polygon-pos",
    alchemySubdomain: "polygon-mainnet",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    nativeErc20: null,
  },
  // Gnosis — native XDAI (uppercase: src/tokens.ts compares input.toUpperCase()).
  // KyberSwap has no aggregator (404); kyberPath null. ks-setting has 0
  // tokens, so the curated list comes from src/tokens_builtin.ts.
  gnosis: {
    alias: "gnosis",
    chainId: 100,
    kyberPath: null,
    displayName: "Gnosis",
    nativeSymbol: "XDAI",
    explorer: "https://gnosisscan.io",
    coingeckoPlatform: "xdai",
    alchemySubdomain: "gnosis-mainnet",
    wrappedNative: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
    nativeErc20: null,
  },
};

export function resolveChain(input: string): ChainInfo {
  const key = input.toLowerCase() as ChainAlias;
  const info = CHAINS[key];
  if (!info) {
    const supported = Object.keys(CHAINS).join(", ");
    throw new Error(`unknown chain "${input}". supported: ${supported}`);
  }
  return info;
}

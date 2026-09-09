// Several viem chain defaults (mainnet's eth.merkle.io notably) reject
// browser-origin requests, which silently kills receipt polling, balance
// reads, and curve init. PublicNode serves permissive CORS on the chains
// we care about.

export const CORS_OPEN_RPC: Record<number, string> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  56: "https://bsc-rpc.publicnode.com",
  100: "https://gnosis-rpc.publicnode.com",
  130: "https://unichain-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  143: "https://rpc3.monad.xyz",
  146: "https://sonic-rpc.publicnode.com",
  250: "https://fantom-rpc.publicnode.com",
  999: "https://rpc.hyperliquid.xyz/evm",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  8453: "https://base-rpc.publicnode.com",
  9745: "https://rpc.plasma.to",
  57073: "https://rpc-gel.inkonchain.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
};

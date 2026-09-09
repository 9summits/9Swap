// Explorer path prefixes (urlAlias). Empty string = mainnet, no prefix.
// CoW explorer does not know Ophis-operated chains (opt / unichain / robinhood).
const COW_PATH_PREFIX: Record<number, string> = {
  1: "",
  56: "bnb",
  100: "gc",
  137: "pol",
  8453: "base",
  42161: "arb1",
  43114: "avax",
  57073: "ink",
  59144: "linea",
  9745: "plasma",
};
const OPHIS_PATH_PREFIX: Record<number, string> = {
  ...COW_PATH_PREFIX,
  10: "opt",
  130: "unichain",
  4663: "robinhood",
};

const EXPLORER: Record<string, { host: string; prefix: Record<number, string> }> =
  {
    cow: { host: "explorer.cow.fi", prefix: COW_PATH_PREFIX },
    ophis: { host: "explorer.ophis.fi", prefix: OPHIS_PATH_PREFIX },
  };

export function orderExplorerUrl(args: {
  venue: string;
  chainId: number;
  orderId: string;
}): string | null {
  const orderId = args.orderId.trim();
  if (!orderId) return null;
  if (args.venue === "delta") {
    return `https://www.velora.xyz/explorer/order/${orderId}/transactions`;
  }
  const spec = EXPLORER[args.venue];
  if (!spec) return null;
  const alias = spec.prefix[args.chainId];
  if (alias === undefined) return `https://${spec.host}/search/${orderId}`;
  const path = alias === "" ? `orders/${orderId}` : `${alias}/orders/${orderId}`;
  return `https://${spec.host}/${path}`;
}

export function orderExplorerCtaLabel(url: string): string {
  try {
    const host = new URL(url).host;
    if (host === "explorer.cow.fi") return "View on CoW Explorer";
    if (host === "explorer.ophis.fi") return "View on Ophis Explorer";
    if (host === "www.velora.xyz" || host === "velora.xyz") {
      return "View on Velora Explorer";
    }
  } catch (e) {
    console.warn("unparseable order explorer url:", url, e);
  }
  return "View order";
}

import { publicClientFor } from "../../wagmi";

const gasPriceCache = new Map<number, Promise<bigint | null>>();

export function gasPriceWeiFor(chainId: number): Promise<bigint | null> {
  let p = gasPriceCache.get(chainId);
  if (p) return p;
  p = (async () => {
    try {
      const client = publicClientFor(chainId);
      if (!client) {
        console.warn(`curve gasPrice: no public client for chain ${chainId}`);
        return null;
      }
      return await client.getGasPrice();
    } catch (e) {
      console.warn("curve gasPrice: eth_gasPrice failed", e);
      return null;
    }
  })();
  gasPriceCache.set(chainId, p);
  return p;
}

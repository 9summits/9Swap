import { keccak_256 } from "@noble/hashes/sha3.js";

export function toChecksumAddress(addr: string): string {
  const clean = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(
      `invalid address "${addr}" — expected 40 hex characters (optional 0x prefix)`,
    );
  }

  const hashBytes = keccak_256(new TextEncoder().encode(clean));
  let hashHex = "";
  for (const b of hashBytes) hashHex += b.toString(16).padStart(2, "0");

  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const c = clean[i]!;
    const h = hashHex[i]!;
    out += /[a-f]/.test(c) && parseInt(h, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

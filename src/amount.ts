export function toBaseUnits(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid amount "${human}" — expected a positive number`);
  }

  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `amount "${human}" has more precision than token decimals (${decimals})`,
    );
  }

  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function fromBaseUnits(
  base: bigint | string,
  decimals: number,
  displayDecimals = 6,
): string {
  const v = typeof base === "string" ? BigInt(base) : base;
  const divisor = 10n ** BigInt(decimals);
  const whole = v / divisor;
  const frac = v % divisor;

  if (frac === 0n) return whole.toString();

  const fracStr = frac.toString().padStart(decimals, "0");
  const shown = fracStr.slice(0, displayDecimals).replace(/0+$/, "");
  return shown.length > 0 ? `${whole}.${shown}` : whole.toString();
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

import { toChecksumAddress } from "./checksum.ts";

/** Base label when REFERRAL_NAME is unset, i.e. an unconfigured self-host. */
export const DEFAULT_REFERRAL_NAME = "swap-selfhost";

export type ReferralConfig = {
  /** Recipient of partner fees / surplus. EIP-55 checksummed. */
  address: string | null;
  /**
   * Free-form label (velora `partner`, kyber `x-client-id`, cow `appCode`,
   * fusion `source`). Defaults to DEFAULT_REFERRAL_NAME, suffixed with the
   * mode when one is set.
   */
  name: string;
  /** Additional fee in basis points (1 bp = 0.01%). 0 = no fee. */
  feeBps: number;
  /**
   * Odos-registered numeric referral code. Used by the legacy V2 venue
   * (`odosv2`) which still exposes the older referralCode mechanism.
   * V3 (`odos`) uses `partnerFeePercent` + `feeRecipient` from
   * REFERRAL_ADDRESS / REFERRAL_FEE_BPS instead. 0 = none.
   */
  odosCode: number;
  /**
   * CoW Protocol affiliate code, embedded in the order's appData document as
   * `metadata.referrer.code`. Case-insensitive (stored uppercase), matches
   * `^[A-Z0-9_-]{5,20}$`. Pure attribution — does not change the quote — so it
   * is preserved under `--nofee`. null = none.
   */
  cowReferralCode: string | null;
  /**
   * Ophis (CoW fork) referral code, embedded in the order's appData as
   * `metadata.ophisReferrer.code`. Case-SENSITIVE (unlike cow's) — stored
   * verbatim, e.g. "mycode". null = none (Ophis venue is then gated off).
   */
  ophisReferralCode: string | null;
};

let cached: ReferralConfig | null = null;

// When true, getReferralConfig() returns the env-derived config with
// `feeBps` and `odosCode` zeroed. `address` and `name` are preserved
// so attribution-only mechanisms (velora `takeSurplus`, matcha
// `tradeSurplusRecipient`, kyber `x-client-id` plus the 0-bps
// feeReceiver quartet, velora/delta `partner` label) still apply —
// surplus capture doesn't worsen the displayed quote, so it stays on.
// Set by `--nofee` early in main() before any venue runs.
let noFeeMode = false;

export type ReferralMode = "cli" | "dapp" | "browser";

// Null leaves the base name unsuffixed. That is the state of the
// non-quoting entry points (`swap update`, `swap --init`) and of tests.
let mode: ReferralMode | null = null;

export function setNoFeeMode(v: boolean): void {
  noFeeMode = v;
  cached = null;
}

export function setReferralMode(next: ReferralMode): void {
  mode = next;
  cached = null;
}

/** Tests only — production entry points set a mode and never clear it. */
export function resetReferralMode(): void {
  mode = null;
  cached = null;
}

export function getReferralConfig(): ReferralConfig {
  if (cached) return cached;

  const rawAddr = process.env.REFERRAL_ADDRESS?.trim();
  let address: string | null = null;
  if (rawAddr) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) {
      throw new Error(`REFERRAL_ADDRESS=${rawAddr} is not a valid 0x 20-byte address`);
    }
    address = toChecksumAddress(rawAddr);
  }

  const base = process.env.REFERRAL_NAME?.trim() || DEFAULT_REFERRAL_NAME;
  const name = mode !== null ? `${base}-${mode}` : base;

  const rawFee = process.env.REFERRAL_FEE_BPS?.trim();
  let feeBps = 0;
  if (rawFee && rawFee !== "") {
    const n = Number(rawFee);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1000) {
      throw new Error(
        `REFERRAL_FEE_BPS=${rawFee} must be an integer in [0, 1000] (max 10%)`,
      );
    }
    feeBps = n;
  }
  if (feeBps > 0 && !address) {
    throw new Error(
      `REFERRAL_FEE_BPS is set (${feeBps}) but REFERRAL_ADDRESS is not — fees would have nowhere to go`,
    );
  }

  // ODOS_REFERRAL_CODE is only consumed by the legacy V2 venue
  // (`odosv2`). V3 (`odos`) ignores it and uses partnerFeePercent +
  // feeRecipient from REFERRAL_ADDRESS / REFERRAL_FEE_BPS instead.
  const rawOdos = process.env.ODOS_REFERRAL_CODE?.trim();
  let odosCode = 0;
  if (rawOdos && rawOdos !== "") {
    const n = Number(rawOdos);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(
        `ODOS_REFERRAL_CODE=${rawOdos} must be a non-negative integer (registered with Odos)`,
      );
    }
    odosCode = n;
  }

  // CoW affiliate code → appData metadata.referrer.code. Case-insensitive,
  // stored uppercase (per the CoW referrer schema). Attribution only, no fee.
  const rawCowCode = process.env.COW_REFERRAL_CODE?.trim();
  let cowReferralCode: string | null = null;
  if (rawCowCode && rawCowCode !== "") {
    const code = rawCowCode.toUpperCase();
    if (!/^[A-Z0-9_-]{5,20}$/.test(code)) {
      throw new Error(
        `COW_REFERRAL_CODE=${rawCowCode} must match ^[A-Z0-9_-]{5,20}$ (CoW affiliate code; letters/digits/_/-, 5-20 chars)`,
      );
    }
    cowReferralCode = code;
  }

  // Ophis referrer code → appData metadata.ophisReferrer.code. Case-sensitive,
  // verbatim (no uppercasing — codes are stored as provided).
  // Attribution only, no fee from us (the Ophis CIP-75 partner fee is separate
  // and always applied on served chains). Grammar mirrors @ophis/sdk's
  // OPHIS_REFERRAL_CODE_RE (lowercase letters/digits/_/-, 3-64): validate and
  // throw on a typo so a bad code fails loud at startup — a malformed code
  // silently never accrues the rebate. Kept as a local regex so referral.ts
  // stays SDK-free; the venue re-validates via buildOphisReferrerMetadata at
  // order build anyway.
  const rawOphisCode = process.env.OPHIS_REFERRAL_CODE?.trim();
  let ophisReferralCode: string | null = null;
  if (rawOphisCode && rawOphisCode !== "") {
    if (!/^[a-z0-9_-]{3,64}$/.test(rawOphisCode)) {
      throw new Error(
        `OPHIS_REFERRAL_CODE=${rawOphisCode} must match ^[a-z0-9_-]{3,64}$ (Ophis referral code; lowercase letters/digits/_/-, 3-64 chars)`,
      );
    }
    ophisReferralCode = rawOphisCode;
  }

  if (noFeeMode) {
    feeBps = 0;
    odosCode = 0;
  }

  cached = { address, name, feeBps, odosCode, cowReferralCode, ophisReferralCode };
  return cached;
}

/** Reset the cache. Tests only — production reads env once at startup. */
export function resetReferralConfigCache(): void {
  cached = null;
  // bun test shares a process; handlers.ts sets "dapp" on import.
  mode = null;
}

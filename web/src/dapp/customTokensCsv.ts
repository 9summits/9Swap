// Pure custom-token CSV + CLI chain-alias table.
// No localStorage, no viem — bun tests import this file directly.

export type CustomTokenChain = {
  chainId: number;
  alias: string;
  name: string;
};

// Kept local so the web bundle never imports src/chains.ts. Must stay in
// lockstep with CHAINS (eth/arb/base/op/avax/bsc/hype/unichain/robinhood/arc/monad/plasma/polygon/gnosis/ink).
export const CUSTOM_TOKEN_CHAINS: readonly CustomTokenChain[] = [
  { chainId: 1, alias: "eth", name: "Ethereum" },
  { chainId: 42161, alias: "arb", name: "Arbitrum" },
  { chainId: 8453, alias: "base", name: "Base" },
  { chainId: 10, alias: "op", name: "Optimism" },
  { chainId: 43114, alias: "avax", name: "Avalanche" },
  { chainId: 56, alias: "bsc", name: "BNB Chain" },
  { chainId: 999, alias: "hype", name: "HyperEVM" },
  { chainId: 130, alias: "unichain", name: "Unichain" },
  { chainId: 4663, alias: "robinhood", name: "Robinhood" },
  { chainId: 5042, alias: "arc", name: "Arc" },
  { chainId: 143, alias: "monad", name: "Monad" },
  { chainId: 9745, alias: "plasma", name: "Plasma" },
  { chainId: 137, alias: "polygon", name: "Polygon" },
  { chainId: 100, alias: "gnosis", name: "Gnosis" },
  { chainId: 57073, alias: "ink", name: "Ink" },
];

const CHAIN_BY_ALIAS = new Map(
  CUSTOM_TOKEN_CHAINS.map((c) => [c.alias, c] as const),
);
const CHAIN_BY_ID = new Map(
  CUSTOM_TOKEN_CHAINS.map((c) => [c.chainId, c] as const),
);

export function chainMetaForAlias(alias: string): CustomTokenChain | undefined {
  return CHAIN_BY_ALIAS.get(alias.trim().toLowerCase());
}

export function chainMetaForId(chainId: number): CustomTokenChain | undefined {
  return CHAIN_BY_ID.get(chainId);
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DECIMALS_RE = /^(0|[1-9]\d*)$/;

export type StoredCustomToken = {
  chainId: number;
  token: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
  };
};

function parseChainKey(key: string): number | null {
  const n = Number(key);
  if (Number.isFinite(n) && n === Math.trunc(n) && n >= 0) return n;
  return chainMetaForAlias(key)?.chainId ?? null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceStoredToken(item: unknown): StoredCustomToken["token"] | null {
  if (!isRecord(item)) return null;
  const rec = item;
  if (typeof rec.address !== "string" || !ADDRESS_RE.test(rec.address)) return null;
  const decimalsRaw = rec.decimals;
  let decimals: number;
  if (typeof decimalsRaw === "number" && Number.isInteger(decimalsRaw)) {
    decimals = decimalsRaw;
  } else if (typeof decimalsRaw === "string" && DECIMALS_RE.test(decimalsRaw.trim())) {
    decimals = Number(decimalsRaw.trim());
  } else {
    return null;
  }
  if (decimals < 0 || decimals > 36) return null;
  const symbol = typeof rec.symbol === "string" && rec.symbol.trim() ? rec.symbol : rec.address.slice(0, 6);
  const name = typeof rec.name === "string" && rec.name.trim() ? rec.name : symbol;
  const token: StoredCustomToken["token"] = {
    address: rec.address.toLowerCase(),
    symbol,
    name,
    decimals,
  };
  if (typeof rec.logoURI === "string" && rec.logoURI) token.logoURI = rec.logoURI;
  return token;
}

// Read the localStorage JSON blob into a flat list. Skips corrupt rows, never
// throws, never guesses decimals. Accepts numeric chainId keys and CLI aliases.
export function storedCustomTokensFromUnknown(store: unknown): StoredCustomToken[] {
  if (!isRecord(store)) return [];
  const out: StoredCustomToken[] = [];
  for (const [key, value] of Object.entries(store)) {
    const chainId = parseChainKey(key);
    if (chainId === null) continue;
    const list = Array.isArray(value) ? value : [];
    for (const item of list) {
      const token = coerceStoredToken(item);
      if (token) out.push({ chainId, token });
    }
  }
  out.sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    const sym = a.token.symbol.localeCompare(b.token.symbol);
    if (sym !== 0) return sym;
    return a.token.address.localeCompare(b.token.address);
  });
  return out;
}

const CSV_HEADER = "chain,symbol,name,address,decimals";

export type CustomTokenCsvRow = {
  chain: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
};

export type ParsedCustomToken = CustomTokenCsvRow & { chainId: number };

export type CsvParseError = { line: number; message: string };

export type ParseCustomTokensCsvResult = {
  ok: ParsedCustomToken[];
  errors: CsvParseError[];
};

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function tokensToCsv(rows: CustomTokenCsvRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.chain),
        csvField(r.symbol),
        csvField(r.name),
        csvField(r.address.toLowerCase()),
        String(r.decimals),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function listedTokensToCsv(
  tokens: Array<{
    alias: string;
    token: { symbol: string; name: string; address: string; decimals: number };
  }>,
): string {
  return tokensToCsv(
    tokens
      .filter((t) => chainMetaForAlias(t.alias) !== undefined)
      .map((t) => ({
        chain: t.alias,
        symbol: t.token.symbol,
        name: t.token.name,
        address: t.token.address,
        decimals: t.token.decimals,
      })),
  );
}

// RFC-4180-ish records. Quoted fields may contain commas/newlines; "" is an
// escaped quote. Line numbers are 1-based at the start of each record.
function parseCsvRecords(text: string): { line: number; fields: string[] }[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const n = src.length;
  const records: { line: number; fields: string[] }[] = [];
  let i = 0;
  let line = 1;
  while (i < n) {
    const startLine = line;
    const fields: string[] = [];
    while (i < n) {
      if (src[i] === '"') {
        i++;
        let field = "";
        while (i < n) {
          const ch = src[i]!;
          if (ch === '"') {
            if (src[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (ch === "\n") line++;
          else if (ch === "\r" && src[i + 1] !== "\n") line++;
          field += ch;
          i++;
        }
        fields.push(field);
      } else {
        let field = "";
        while (i < n) {
          const ch = src[i]!;
          if (ch === "," || ch === "\n" || ch === "\r") break;
          field += ch;
          i++;
        }
        fields.push(field);
      }
      if (src[i] === ",") {
        i++;
        continue;
      }
      break;
    }
    if (src[i] === "\r") {
      i++;
      if (src[i] === "\n") i++;
      line++;
    } else if (src[i] === "\n") {
      i++;
      line++;
    }
    const blank =
      fields.length === 0 || (fields.length === 1 && fields[0]!.trim() === "");
    if (!blank) records.push({ line: startLine, fields });
  }
  return records;
}

export function parseCustomTokensCsv(text: string): ParseCustomTokensCsvResult {
  const ok: ParsedCustomToken[] = [];
  const errors: CsvParseError[] = [];
  const records = parseCsvRecords(text);
  if (records.length === 0) {
    return {
      ok,
      errors: [{ line: 1, message: `missing header row: ${CSV_HEADER}` }],
    };
  }
  const header = records[0]!;
  const cols = header.fields.map((f) => f.trim().toLowerCase());
  const idx = {
    chain: cols.indexOf("chain"),
    symbol: cols.indexOf("symbol"),
    name: cols.indexOf("name"),
    address: cols.indexOf("address"),
    decimals: cols.indexOf("decimals"),
  };
  const missing = (Object.keys(idx) as (keyof typeof idx)[]).filter(
    (k) => idx[k] < 0,
  );
  if (missing.length > 0) {
    return {
      ok,
      errors: [
        {
          line: header.line,
          message: `missing header column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} (expected ${CSV_HEADER})`,
        },
      ],
    };
  }

  for (const rec of records.slice(1)) {
    const cell = (key: keyof typeof idx): string =>
      (rec.fields[idx[key]] ?? "").trim();
    const chainRaw = cell("chain").toLowerCase();
    const symbol = cell("symbol");
    const name = cell("name");
    const addressRaw = cell("address");
    const decimalsRaw = cell("decimals");
    const rowErrors: string[] = [];

    const meta = chainMetaForAlias(chainRaw);
    if (!meta) rowErrors.push(`unknown chain "${cell("chain")}"`);

    if (!symbol) rowErrors.push("empty symbol");
    if (!name) rowErrors.push("empty name");

    if (!ADDRESS_RE.test(addressRaw)) {
      rowErrors.push("address must be 0x + 40 hex chars");
    }

    // Decimals are safety-critical — never coerce/default to 18.
    if (!DECIMALS_RE.test(decimalsRaw)) {
      rowErrors.push("decimals must be an integer 0–36 (never guessed)");
    } else {
      const decimals = Number(decimalsRaw);
      if (decimals < 0 || decimals > 36) {
        rowErrors.push(`decimals ${decimals} out of range 0–36`);
      }
    }

    if (rowErrors.length > 0) {
      errors.push({ line: rec.line, message: rowErrors.join("; ") });
      continue;
    }
    ok.push({
      chain: meta!.alias,
      chainId: meta!.chainId,
      symbol,
      name,
      address: addressRaw.toLowerCase(),
      decimals: Number(decimalsRaw),
    });
  }
  return { ok, errors };
}

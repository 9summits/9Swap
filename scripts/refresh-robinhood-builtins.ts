// Regenerates ROBINHOOD_4663 in src/tokens_builtin.ts from the official
// Robinhood Chain contract docs, then overwrites every symbol/name/decimals
// with on-chain eth_call results. Logos: keep existing by address, else
// Uniswap interface GraphQL. Rerun: bun run scripts/refresh-robinhood-builtins.ts
//
// Never prints the RPC URL (it may contain a key).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAINS } from "../src/chains.ts";
import { toChecksumAddress } from "../src/checksum.ts";
import { builtinTokens, type BuiltinToken } from "../src/tokens_builtin.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "src", "tokens_builtin.ts");
const FALLBACK_DOCS = join(ROOT, "scratch-rh-contracts.md");
const JINA_DOCS = "https://r.jina.ai/https://docs.robinhood.com/chain/contracts/";
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const UNISWAP_GQL = "https://interface.gateway.uniswap.org/v1/graphql";

const WETH_LC = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG_LC = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const MIN_STOCKS = 150;

const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
} as const;

const UA = "Mozilla/5.0 (compatible; swap-refresh-robinhood/1.0; bun)";

type DocsRow = {
  address: string;
  docsSymbol: string;
  docsName: string | null;
};

function fail(msg: string): never {
  console.error(`refresh-robinhood-builtins: ${msg}`);
  process.exit(1);
}

function loadKeyValueFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function envFiles(): string[] {
  const files = [join(ROOT, ".env")];
  try {
    const common = spawnSync("git", ["-C", ROOT, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
    });
    if (common.status === 0) {
      const gitDir = common.stdout.trim();
      if (gitDir) files.push(join(gitDir, "..", ".env"));
    }
  } catch {
    // no git; ROOT/.env and process env still apply
  }
  return files;
}

function rpcCandidates(): string[] {
  const file: Record<string, string> = {};
  for (const path of envFiles()) Object.assign(file, loadKeyValueFile(path));
  const out: string[] = [];
  const add = (u: string | undefined) => {
    if (u && !out.includes(u)) out.push(u);
  };
  add(process.env.ROBINHOOD_RPC_URL);
  add(process.env.RPC_URL_4663);
  add(file.ROBINHOOD_RPC_URL);
  add(file.RPC_URL_4663);
  const alchemy = process.env.ALCHEMY_API_KEY || file.ALCHEMY_API_KEY;
  if (alchemy) add(`https://robinhood-mainnet.g.alchemy.com/v2/${alchemy}`);
  // Public RPC 429s on batched eth_call; keep it last.
  add(PUBLIC_RPC);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { accept: "text/plain, text/markdown, */*", "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

async function loadDocs(): Promise<{ markdown: string; source: string }> {
  try {
    const markdown = await fetchText(JINA_DOCS);
    if (!/0x[0-9a-fA-F]{40}/.test(markdown)) {
      throw new Error("live docs had no contract addresses");
    }
    return { markdown, source: "live jina" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!existsSync(FALLBACK_DOCS)) {
      fail(`live docs failed (${why}) and ${FALLBACK_DOCS} is missing`);
    }
    console.error(`live docs failed (${why}); using ${FALLBACK_DOCS}`);
    return { markdown: readFileSync(FALLBACK_DOCS, "utf8"), source: "fallback file" };
  }
}

const ADDR_RE = /0x[0-9a-fA-F]{40}/;

function stripCell(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}

function tableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    if (/^\|\s*:?-{3,}/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    const joined = cells.map((c) => stripCell(c).toLowerCase()).join(" ");
    if (/\bsymbol\b/.test(joined) && /\bcontract\b/.test(joined)) continue;
    rows.push(cells);
  }
  return rows;
}

function parseDocs(markdown: string): DocsRow[] {
  const stockAt = markdown.search(/###?\s*Stock Tokens/i);
  const coreMd = stockAt === -1 ? markdown : markdown.slice(0, stockAt);
  const stockMd = stockAt === -1 ? "" : markdown.slice(stockAt);

  const out: DocsRow[] = [];
  const seen = new Set<string>();
  const push = (row: DocsRow) => {
    const lc = row.address.toLowerCase();
    if (seen.has(lc)) return;
    seen.add(lc);
    out.push(row);
  };

  for (const cells of tableRows(coreMd)) {
    const addrCell = cells.find((c) => ADDR_RE.test(c));
    if (!addrCell) continue;
    const m = addrCell.match(ADDR_RE);
    if (!m) continue;
    const symbol = stripCell(cells[0] ?? "");
    if (!symbol) continue;
    push({ address: m[0], docsSymbol: symbol, docsName: null });
  }

  const coreCount = out.length;
  if (!out.some((r) => r.address.toLowerCase() === WETH_LC && r.docsSymbol.toUpperCase() === "WETH")) {
    fail("core table is missing WETH");
  }
  if (!out.some((r) => r.address.toLowerCase() === USDG_LC && r.docsSymbol.toUpperCase() === "USDG")) {
    fail("core table is missing USDG");
  }

  for (const cells of tableRows(stockMd)) {
    const addrCell = cells.find((c) => ADDR_RE.test(c));
    if (!addrCell) continue;
    const m = addrCell.match(ADDR_RE);
    if (!m) continue;
    const docsName = stripCell(cells[0] ?? "") || null;
    const docsSymbol = stripCell(cells[1] ?? "");
    if (!docsSymbol) continue;
    push({ address: m[0], docsSymbol, docsName });
  }

  const stocks = out.length - coreCount;
  if (stocks < MIN_STOCKS) {
    fail(`stock table has ${stocks} rows, expected at least ${MIN_STOCKS}`);
  }
  return out;
}

type RpcItem = { jsonrpc: string; id: number; result?: string; error?: { message: string } };

async function rpcPost(rpc: string, body: unknown): Promise<unknown> {
  let last = "rpc failed";
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(rpc, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": UA,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status >= 500) {
      last = `rpc ${res.status} ${res.statusText}`;
      await sleep(Math.min(20_000, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);
    return await res.json();
  }
  throw new Error(last);
}

async function pickRpc(): Promise<string> {
  let last = "no RPC candidate answered";
  for (const rpc of rpcCandidates()) {
    try {
      const json = (await rpcPost(rpc, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      })) as RpcItem;
      if (json.error) {
        last = json.error.message;
        continue;
      }
      if (json.result !== undefined && Number(BigInt(json.result)) === 4663) return rpc;
      last = "wrong chainId";
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  fail(last);
}

async function ethCallBatch(
  rpc: string,
  calls: { to: string; data: string }[],
): Promise<string[]> {
  const chunkSize = 20;
  const out: string[] = new Array(calls.length);
  for (let i = 0; i < calls.length; i += chunkSize) {
    const chunk = calls.slice(i, i + chunkSize);
    const payload = chunk.map((c, j) => ({
      jsonrpc: "2.0",
      id: i + j,
      method: "eth_call",
      params: [{ to: c.to, data: c.data }, "latest"],
    }));
    let json: unknown;
    try {
      json = await rpcPost(rpc, payload);
    } catch {
      json = null;
    }
    if (!Array.isArray(json)) {
      json = [];
      for (const req of payload) {
        (json as unknown[]).push(await rpcPost(rpc, req));
      }
    }
    const items = json as RpcItem[];
    const byId = new Map<number, RpcItem>();
    for (const item of items) byId.set(item.id, item);
    for (let j = 0; j < chunk.length; j++) {
      const id = i + j;
      const item = byId.get(id);
      if (!item) fail(`rpc batch missing id ${id}`);
      if (item.error) fail(`eth_call id ${id}: ${item.error.message}`);
      if (item.result === undefined) fail(`eth_call id ${id}: no result`);
      out[id] = item.result;
    }
  }
  return out;
}

function decodeUint(hex: string): number {
  if (!hex || hex === "0x") fail("decimals() returned empty");
  const n = Number(BigInt(hex));
  if (!Number.isInteger(n) || n < 0 || n > 36) fail(`decimals() returned ${n}`);
  return n;
}

function decodeString(hex: string, label: string): string {
  if (!hex || hex === "0x") fail(`${label}() returned empty`);
  const raw = hex.replace(/^0x/i, "");
  if (raw.length === 64) {
    const buf = Buffer.from(raw, "hex");
    const nul = buf.indexOf(0);
    const s = buf.subarray(0, nul === -1 ? buf.length : nul).toString("utf8").replace(/\0+$/g, "").trim();
    if (!s) fail(`${label}() decoded empty bytes32`);
    return s;
  }
  if (raw.length < 128) fail(`${label}() result too short`);
  const offset = Number(BigInt("0x" + raw.slice(0, 64)));
  const lenStart = offset * 2;
  if (lenStart + 64 > raw.length) fail(`${label}() offset out of range`);
  const len = Number(BigInt("0x" + raw.slice(lenStart, lenStart + 64)));
  const dataStart = lenStart + 64;
  const bytes = Buffer.from(raw.slice(dataStart, dataStart + len * 2), "hex");
  const s = bytes.toString("utf8").replace(/\0+$/g, "").trim();
  if (!s) fail(`${label}() decoded empty string`);
  return s;
}

async function fillLogos(tokens: BuiltinToken[]): Promise<void> {
  const missing = tokens.filter((t) => !t.logoURI);
  if (missing.length === 0) return;
  const byAddr = new Map(missing.map((t) => [t.address.toLowerCase(), t]));
  try {
    for (let i = 0; i < missing.length; i += 60) {
      const chunk = missing.slice(i, i + 60);
      const res = await fetch(UNISWAP_GQL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.uniswap.org",
          "user-agent": UA,
        },
        body: JSON.stringify({
          query:
            "query T($contracts: [ContractInput!]!) { tokens(contracts: $contracts) { address project { logoUrl } } }",
          variables: {
            contracts: chunk.map((t) => ({ chain: "ROBINHOOD", address: t.address })),
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = (await res.json()) as {
        data?: { tokens?: ({ address: string; project?: { logoUrl?: string | null } | null } | null)[] };
      };
      for (const t of json.data?.tokens ?? []) {
        const logo = t?.project?.logoUrl;
        if (!t || !logo) continue;
        const target = byAddr.get(t.address.toLowerCase());
        if (target) target.logoURI = logo;
      }
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.error(`uniswap logo back-fill failed (${why}); omitting missing logoURI`);
  }
}

function formatToken(t: BuiltinToken): string {
  const fields = [
    `address: ${JSON.stringify(t.address)}`,
    `symbol: ${JSON.stringify(t.symbol)}`,
    `decimals: ${t.decimals}`,
    `name: ${JSON.stringify(t.name)}`,
  ];
  if (t.aliases && t.aliases.length > 0) fields.push(`aliases: ${JSON.stringify(t.aliases)}`);
  if (t.logoURI) fields.push(`logoURI: ${JSON.stringify(t.logoURI)}`);
  return `  { ${fields.join(", ")} },`;
}

function rewriteRobinhoodArray(src: string, tokens: BuiltinToken[]): string {
  const startMarker = "const ROBINHOOD_4663: BuiltinToken[] = [";
  const start = src.indexOf(startMarker);
  if (start < 0) fail("ROBINHOOD_4663 array not found in tokens_builtin.ts");
  const bodyStart = start + startMarker.length;
  let depth = 1;
  let i = bodyStart;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    i++;
  }
  if (depth !== 0) fail("ROBINHOOD_4663 array is unclosed");
  let end = i;
  if (src[end] === ";") end++;
  const body = tokens.map(formatToken).join("\n");
  return src.slice(0, start) + `${startMarker}\n${body}\n];` + src.slice(end);
}

function assertUnique(tokens: BuiltinToken[]): void {
  const labels = new Set<string>();
  const addrs = new Set<string>();
  for (const t of tokens) {
    for (const label of [t.symbol, ...(t.aliases ?? [])]) {
      const up = label.toUpperCase();
      if (labels.has(up)) fail(`duplicate symbol/alias ${label}`);
      labels.add(up);
    }
    const lc = t.address.toLowerCase();
    if (addrs.has(lc)) fail(`duplicate address ${t.address}`);
    addrs.add(lc);
    if (!/^0x[0-9a-fA-F]{40}$/.test(t.address)) fail(`${t.symbol} address is not 20 bytes`);
    if (toChecksumAddress(t.address) !== t.address) fail(`${t.symbol} is not EIP-55 checksummed`);
  }
}

const existing = builtinTokens(4663);
const existingByAddr = new Map(existing.map((t) => [t.address.toLowerCase(), t]));

const { markdown, source } = await loadDocs();
const docs = parseDocs(markdown);
console.error(`docs: ${docs.length} rows from ${source} (WETH+USDG + stocks)`);

const wrapped = CHAINS.robinhood.wrappedNative.toLowerCase();
if (wrapped !== WETH_LC) fail("CHAINS.robinhood.wrappedNative does not match official WETH");

const rpc = await pickRpc();
const calls: { to: string; data: string }[] = [];
for (const row of docs) {
  calls.push({ to: row.address, data: SEL.symbol });
  calls.push({ to: row.address, data: SEL.name });
  calls.push({ to: row.address, data: SEL.decimals });
}
const results = await ethCallBatch(rpc, calls);

const divergences: string[] = [];
const verified: BuiltinToken[] = [];
for (let i = 0; i < docs.length; i++) {
  const row = docs[i]!;
  const symbol = decodeString(results[i * 3]!, "symbol");
  const name = decodeString(results[i * 3 + 1]!, "name");
  const decimals = decodeUint(results[i * 3 + 2]!);
  const address = toChecksumAddress(row.address);
  const prev = existingByAddr.get(row.address.toLowerCase());
  const aliases: string[] = [];
  const seenAlias = new Set<string>();
  const addAlias = (a: string) => {
    const up = a.toUpperCase();
    if (up === symbol.toUpperCase()) return;
    if (seenAlias.has(up)) return;
    seenAlias.add(up);
    aliases.push(a);
  };
  if (row.docsSymbol.toUpperCase() !== symbol.toUpperCase()) addAlias(row.docsSymbol);
  for (const a of prev?.aliases ?? []) addAlias(a);

  if (row.docsSymbol.toUpperCase() !== symbol.toUpperCase()) {
    divergences.push(`${address} docs=${row.docsSymbol} on-chain=${symbol}`);
  }

  const token: BuiltinToken = { address, symbol, name, decimals };
  if (aliases.length > 0) token.aliases = aliases;
  if (prev?.logoURI) token.logoURI = prev.logoURI;
  verified.push(token);
}

await fillLogos(verified);

const weth = verified.find((t) => t.address.toLowerCase() === WETH_LC);
const usdg = verified.find((t) => t.address.toLowerCase() === USDG_LC);
if (!weth) fail("on-chain set is missing WETH");
if (!usdg) fail("on-chain set is missing USDG");
const stocks = verified
  .filter((t) => t.address.toLowerCase() !== WETH_LC && t.address.toLowerCase() !== USDG_LC)
  .sort((a, b) => a.symbol.localeCompare(b.symbol, "en"));
const ordered = [weth, usdg, ...stocks];
assertUnique(ordered);

const src = readFileSync(TARGET, "utf8");
writeFileSync(TARGET, rewriteRobinhoodArray(src, ordered));

const keptLogos = ordered.filter((t) => t.logoURI && existingByAddr.get(t.address.toLowerCase())?.logoURI).length;
const newLogos = ordered.filter((t) => t.logoURI && !existingByAddr.get(t.address.toLowerCase())?.logoURI).length;
const omitted = ordered.filter((t) => !t.logoURI).length;
console.error(`on-chain: ${ordered.length} tokens (WETH, USDG, ${stocks.length} stocks)`);
if (divergences.length === 0) console.error("docs vs on-chain symbol: no divergences");
else {
  console.error(`docs vs on-chain symbol: ${divergences.length} divergence(s)`);
  for (const d of divergences) console.error(`  ${d}`);
}
console.error(`logos: kept ${keptLogos}, filled ${newLogos}, omitted ${omitted}`);
console.error(`wrote ${TARGET}`);

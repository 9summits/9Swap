import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ChainInfo } from "../chains.ts";
import { getRpcUrl } from "../rpc.ts";
import { NATIVE_SENTINEL } from "../tokens.ts";
import type {
  BuildTxParams,
  NormalizedHop,
  NormalizedQuote,
  NormalizedTx,
} from "./types.ts";
import { UnsupportedChainError } from "./types.ts";

// Experimental Curve-only venue: Michael Egorov's electric-router
// (https://github.com/michwill/electric-router). Quote + build shell out to
// the `erouter` CLI — this repo does not vendor that AGPL-3.0 solver.
//
// Ethereum mainnet only. Opt-in via `-v electric` / `-v curve,electric`; it is
// never part of `-v all` or the dApp venue list (a cold `erouter` quote is
// tens of seconds, not 15).
//
//   EROUTER_BIN   path to the `erouter` executable (else `erouter` on PATH)
//   EROUTER_CWD   working directory of the electric-router checkout so
//                 `data/` state caches resolve (recommended)

export const ELECTRIC_TIMEOUT_MS = 180_000;

// CREATE2 ElectricRouter.vy — same address on every chain they deployed.
const ELECTRIC_ROUTER = "0xf5438dafc165b466f4a61ce57bd3aa59bcd5979e";

export type ErouterRequest = {
  tokenIn: string;
  tokenOut: string;
  amountWei: string;
  slippageBps: number;
  rpcUrl?: string;
};

export type ErouterRunner = (req: ErouterRequest) => Promise<unknown>;

let runnerOverride: ErouterRunner | null = null;

/** Tests only — production always spawns `erouter`. */
export function setErouterRunnerForTests(fn: ErouterRunner | null): void {
  runnerOverride = fn;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asStringish(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return v.toString();
  return null;
}

type ErouterCall = {
  to: string;
  calldata: string;
  tokenIn: string;
  guaranteedOut: string | null;
};

type ErouterLeg = {
  kind: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  symbolIn: string | null;
  symbolOut: string | null;
  amountIn: string;
  amountOut: string;
  poolName: string | null;
};

type ErouterQuote = {
  amountOut: string;
  legs: ErouterLeg[];
  call: ErouterCall | null;
};

function parseCall(raw: unknown): ErouterCall | null {
  if (!isRecord(raw)) return null;
  const to = asString(raw.to);
  const calldata = asString(raw.calldata);
  const tokenIn = asString(raw.token_in);
  if (!to || !calldata || !tokenIn) return null;
  if (!calldata.startsWith("0x") && !calldata.startsWith("0X")) return null;
  return {
    to,
    calldata,
    tokenIn,
    guaranteedOut: asStringish(raw.guaranteed_out),
  };
}

function parseLeg(raw: unknown): ErouterLeg | null {
  if (!isRecord(raw)) return null;
  const kind = asString(raw.kind) ?? "SWAP";
  const target = asString(raw.target);
  const tokenIn = asString(raw.token_in);
  const tokenOut = asString(raw.token_out);
  const amountIn = asStringish(raw.amount_in);
  const amountOut = asStringish(raw.amount_out);
  if (!target || !tokenIn || !tokenOut || !amountIn || !amountOut) return null;
  return {
    kind,
    target,
    tokenIn,
    tokenOut,
    symbolIn: asString(raw.symbol_in),
    symbolOut: asString(raw.symbol_out),
    amountIn,
    amountOut,
    poolName: asString(raw.pool_name),
  };
}

function parseErouterQuote(raw: unknown): ErouterQuote {
  if (!isRecord(raw)) {
    throw new Error("electric: erouter JSON is not an object");
  }
  const result = isRecord(raw.result) ? raw.result : null;
  const amountOut = result ? asStringish(result.amount_out) : null;
  if (!amountOut || amountOut === "0") {
    throw new Error("electric: erouter returned no amount_out");
  }
  const legsRaw = Array.isArray(raw.legs) ? raw.legs : [];
  const legs: ErouterLeg[] = [];
  for (const item of legsRaw) {
    const leg = parseLeg(item);
    if (leg) legs.push(leg);
  }
  if (legs.length === 0) {
    throw new Error("electric: erouter returned no legs");
  }
  return { amountOut, legs, call: parseCall(raw.call) };
}

function normalizeNative(addr: string): string {
  const a = addr.toLowerCase();
  if (a === "0x0000000000000000000000000000000000000000" || a === NATIVE_SENTINEL) {
    return NATIVE_SENTINEL;
  }
  return a;
}

function isNative(addr: string): boolean {
  return normalizeNative(addr) === NATIVE_SENTINEL;
}

function labelForLeg(leg: ErouterLeg): string {
  if (leg.poolName) return `Curve ${leg.poolName}`;
  switch (leg.kind) {
    case "SWAP_STABLE":
      return "Curve StableSwap";
    case "SWAP_CRYPTO":
      return "Curve Crypto";
    case "WRAP_NATIVE":
      return "Wrap native";
    case "UNWRAP_NATIVE":
      return "Unwrap native";
    case "WSTETH_WRAP":
      return "wstETH wrap";
    case "WSTETH_UNWRAP":
      return "wstETH unwrap";
    case "ERC4626_DEPOSIT":
      return "ERC4626 deposit";
    case "ERC4626_REDEEM":
      return "ERC4626 redeem";
    default:
      return leg.kind.replaceAll("_", " ").toLowerCase();
  }
}

function estimateGasUnits(legs: ErouterLeg[]): number {
  let total = 80_000;
  for (const leg of legs) {
    switch (leg.kind) {
      case "SWAP_CRYPTO":
        total += 220_000;
        break;
      case "WRAP_NATIVE":
      case "UNWRAP_NATIVE":
        total += 45_000;
        break;
      case "WSTETH_WRAP":
      case "WSTETH_UNWRAP":
        total += 60_000;
        break;
      case "ERC4626_DEPOSIT":
      case "ERC4626_REDEEM":
        total += 80_000;
        break;
      default:
        total += 150_000;
    }
  }
  return total;
}

function defaultCheckout(): string {
  return join(homedir(), "git/electric-router");
}

function resolveCwd(): string | undefined {
  const env = process.env.EROUTER_CWD?.trim();
  if (env) return env;
  const home = defaultCheckout();
  if (existsSync(join(home, "pyproject.toml"))) return home;
  return undefined;
}

function resolveBin(): string {
  const raw = process.env.EROUTER_BIN?.trim();
  if (raw) return raw;
  const found = Bun.which("erouter");
  if (found) return found;
  const cwd = resolveCwd();
  for (const p of [
    cwd ? join(cwd, ".venv/bin/erouter") : "",
    join(defaultCheckout(), ".venv/bin/erouter"),
  ]) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    "electric: erouter not found — set EROUTER_BIN to the electric-router CLI (https://github.com/michwill/electric-router)",
  );
}

function summarizeFail(stdout: string, stderr: string, exitCode: number): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = [...lines]
    .reverse()
    .find(
      (l) =>
        l.includes("✘") ||
        /error/i.test(l) ||
        l.includes("failed") ||
        l.includes("no route"),
    );
  const snippet = hit ?? (lines.slice(-2).join(" | ") || `exit ${exitCode}`);
  return `electric: erouter failed (exit ${exitCode}): ${snippet}`;
}

async function spawnErouter(
  req: ErouterRequest,
  chain: ChainInfo,
): Promise<unknown> {
  const bin = resolveBin();
  if (isAbsolute(bin)) {
    const file = Bun.file(bin);
    if (!(await file.exists())) {
      throw new Error(`electric: EROUTER_BIN not found: ${bin}`);
    }
  }
  const rpcUrl = req.rpcUrl ?? getRpcUrl(chain);
  const jsonPath = join(
    tmpdir(),
    `erouter-${Date.now()}-${randomBytes(4).toString("hex")}.json`,
  );
  const cwd = resolveCwd();
  const args = [
    "route",
    "--from",
    req.tokenIn,
    "--to",
    req.tokenOut,
    "--amount-wei",
    req.amountWei,
    "--chain",
    "ethereum",
    "--rpc-url",
    rpcUrl,
    "--json",
    jsonPath,
    "--calldata",
    "needed",
    "--slippage-bp",
    String(req.slippageBps),
    "--no-color",
    "--ascii",
  ];
  // Local EVM needs the compiled `erouter_evm` extension (not installed by
  // `uv sync`). Without it erouter exits 4 rather than falling back. Wire
  // quotes are slower and not identical; set EROUTER_LOCAL=1 once the
  // extension is built (`uv pip install ./rust/evm`).
  if (process.env.EROUTER_LOCAL !== "1") args.push("--no-local");
  const proc = Bun.spawn([bin, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const killer = setTimeout(() => {
    proc.kill("SIGTERM");
  }, ELECTRIC_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    try {
      const out = Bun.file(jsonPath);
      if (await out.exists()) {
        return await out.json();
      }
    } finally {
      await unlink(jsonPath).catch(() => {});
    }
    if (exitCode !== 0) {
      throw new Error(summarizeFail(stdout, stderr, exitCode));
    }
    throw new Error(`electric: erouter wrote no JSON (${summarizeFail(stdout, stderr, exitCode)})`);
  } finally {
    clearTimeout(killer);
  }
}

async function loadPayload(
  req: ErouterRequest,
  chain: ChainInfo,
): Promise<ErouterQuote> {
  if (runnerOverride) return parseErouterQuote(await runnerOverride(req));
  return parseErouterQuote(await spawnErouter(req, chain));
}

export async function quote(params: {
  chain: ChainInfo;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  slippageBps: number;
}): Promise<NormalizedQuote> {
  if (params.chain.chainId !== 1) {
    throw new UnsupportedChainError("electric", params.chain.displayName);
  }
  const parsed = await loadPayload(
    {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountWei: params.amountIn.toString(),
      slippageBps: params.slippageBps,
    },
    params.chain,
  );

  const hops: NormalizedHop[] = parsed.legs.map((leg) => ({
    tokenIn: normalizeNative(leg.tokenIn),
    tokenOut: normalizeNative(leg.tokenOut),
    exchange: labelForLeg(leg),
    swapAmount: leg.amountIn,
    amountOut: leg.amountOut,
    pool: leg.target,
  }));

  return {
    venue: "electric",
    amountIn: params.amountIn.toString(),
    amountOut: parsed.amountOut,
    minAmountOut: parsed.call?.guaranteedOut ?? undefined,
    amountInUsd: null,
    amountOutUsd: null,
    gasUnits: estimateGasUnits(parsed.legs),
    gasPriceWei: null,
    gasUsd: null,
    router: parsed.call?.to ?? ELECTRIC_ROUTER,
    hops,
    tokenHints: new Map(),
    raw: { call: parsed.call },
  };
}

function readCall(raw: unknown): ErouterCall {
  if (!isRecord(raw) || !isRecord(raw.call)) {
    throw new Error(
      "electric build: quote.raw.call missing — re-quote with erouter --calldata",
    );
  }
  const to = asString(raw.call.to);
  const calldata = asString(raw.call.calldata);
  const tokenIn = asString(raw.call.tokenIn);
  if (!to || !calldata || !tokenIn) {
    throw new Error(
      "electric build: quote.raw.call missing — re-quote with erouter --calldata",
    );
  }
  return {
    to,
    calldata,
    tokenIn,
    guaranteedOut: asStringish(raw.call.guaranteedOut),
  };
}

export async function buildTx(params: BuildTxParams): Promise<NormalizedTx> {
  if (params.chain.chainId !== 1) {
    throw new UnsupportedChainError("electric", params.chain.displayName);
  }
  const call = readCall(params.quote.raw);
  const value = isNative(params.tokenIn) ? params.amountIn.toString() : "0";
  return {
    to: call.to,
    from: params.sender,
    data: call.calldata,
    value,
    gas: null,
    gasPrice: null,
    maxPriorityFeePerGas: null,
    spender: call.to,
    chainId: params.chain.chainId,
  };
}

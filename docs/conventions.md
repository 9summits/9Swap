# Conventions & non-negotiable rules

Cross-cutting rules that hold across every adapter, renderer, and command. When
in doubt, these override local convenience.

## Representation

- Internal native-token representation is the KyberSwap sentinel
  `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`. Adapters translate to/from their
  own native representation at their boundary (Odos uses `0x0000…0000`, for
  example).
- All addresses are lowercased before comparisons or map keys.
- Large integers (wei, raw amounts) stay as **strings** in JSON output; numbers
  are used only where precision loss is safe (USD, percentages, gas gwei).

## Error handling & exit codes

- Errors thrown from `main()` go through a single catch that respects `--json`
  (machine-readable `{error}`) vs. text (red `✗` on stderr). Exit code is 1 on
  any failure.

### No silent catches

Never write a silent `catch`. Runtime errors that aren't fatal are still logged.
Concretely for RPC (429s, timeouts, offline): they follow the "never silent
catch" rule — logged to stderr as warnings — and the non-critical paths (e.g.
`priorityFee`) degrade to `null` rather than aborting the command. The only hard
failure in the RPC layer is missing _config_ (see below), not a runtime error.
The same shape applies to CoinGecko 429s in `src/tokens.ts`: one short capped
retry (logged), then a typed `CoinGeckoRateLimitError` plus a module-level
cooldown — bounded waits, a visible reason, and the address path still degrades
to the on-chain `decimals()` read (see
[token-resolution](./architecture.md#token-resolution)).

## Decimals are safety-critical

A wrong `decimals` rescales `toBaseUnits(amount, decimals)` by 10^N and corrupts
**both** the displayed quote and the built approve/swap calldata (silently asking
for 10^12× too much, etc). Therefore:

- `resolveDecimals(chain, address, offChainDecimals)` prefers the off-chain value
  when present; otherwise it reads `decimals()` on-chain (selector `0x313ce567`,
  bounded to `[0, 36]`).
- If neither source yields a value, the command **fails** with a message pointing
  at `ALCHEMY_API_KEY` / `<ALIAS>_RPC_URL`. It never returns a guessed decimals.
- The CoinGecko branches (both symbol and address) use `decimal_place` only when
  it is actually a number — never coerce `null` to `18`.

See the [token-resolution](./architecture.md#token-resolution) section for the
full lookup chain.

## No public RPC fallbacks

The CLI has **no public RPC fallbacks**. If `-d` (or anything needing an RPC) is
used without either a direct RPC override or `ALCHEMY_API_KEY`, `getRpcUrl` throws
`RpcConfigError` with the exact env var name to set. This is intentional: public
RPCs are unreliable, rate-limit aggressively, and give inconsistent allowance
reads. Missing _config_ is the only hard failure; runtime RPC errors degrade as
described above. RPC URL resolution order is documented in
[architecture.md](./architecture.md#rpc-url-resolution).

The interactive dApp server last-resorts to the shared PublicNode table in
`shared/public_rpc.ts` when Alchemy and per-chain overrides are unset. There is
no runtime fallback when Alchemy is set but the request 404s.

## Key loading & key-missing behavior

**Key loading** — `src/env.ts` reads `.env` from the current working directory on
startup and fills `process.env` (without overwriting already-set shell exports).
`.env.example` documents the variables. The `.env` file itself is gitignored.

**Key-missing behavior**

- `-v all` — `availableVenues()` in `src/venues/index.ts` filters out any venue
  whose env var is unset *before* dispatching. Keyless under `-v all` are kyber
  (public host), velora, curve (needs RPC), openocean (public host, 2 rps), plus
  async cow/delta with `--allow-async`. Gated: matcha, 1inch, fusion, uniswap,
  uniswapx, ophis. Gated API-key venues (not ophis) print a stderr note naming
  the missing env vars; they still produce no comparison error rows. Async
  venues still need `--allow-async`.
- `-v matcha` / `-v 1inch` explicitly — if the key is missing, throws
  `MissingApiKeyError` with the signup URL. A user who explicitly selected the
  venue deserves an explanation rather than a silent no-op.

## Approvals

The generated `approve` tx uses the **exact** `amountIn` (not infinite) for
safety and minimum-trust reasoning. Users wanting infinite approval can call
`approve(spender, uint256.max)` themselves. Always read `tx.spender` (not
`tx.to`) when reasoning about which address needs the approval — Velora's spender
diverges from its router. See
[Spender field](./architecture.md#spender-field).

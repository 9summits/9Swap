# Quote vs. execution accuracy (sync venues)

Investigation prompted by a dApp report: *"for every quote I get less when I
simulate the tx — it looks like the quotes are before venue fees."*

## Method

For each sync venue we ran the real pipeline end-to-end and compared the
**quoted `amountOut`** against the **`eth_simulateV1` receipt** of the built
swap (prank balance → `approve` + `swap` → measure tokenOut delta):

```
swap <amt> <in> <out> -v <venue> --from <addr> -d --simulate --json --chain eth
deltaBps = (received - quoted) / quoted × 10_000
```

Matrix: stable→stable (10k/50k/100k USDC/USDT/DAI) and volatile legs
(WETH↔USDC, WBTC↔WETH, WETH↔DAI), several repeats per pair on Ethereum
mainnet. A negative delta means the user receives **less** than the quote
displayed.

## Findings

| Venue       | Stable pairs | Volatile pairs | Verdict |
|-------------|-------------|----------------|---------|
| **velora**  | ~0 bp       | ~0 bp          | Accurate — quote = receivable |
| **1inch**   | ~0 bp       | ~0 bp          | Accurate |
| **curve**   | 0 bp        | 0 bp           | Exact — quote = receivable (and fixed a stdout leak, see below) |
| **uniswap** | ~0 bp       | honest (see note) | Quote ≤ the accurate venues — never overstates |
| **openocean** | **−1 bp** | **−10 to −13 bp** | **Systematically optimistic — fixed (see below)** |
| **kyber**   | ~0 bp       | −4 to −8 bp    | Mildly optimistic on volatile — inherent, no correctable field |
| **odosv2**  | ~0 bp       | −6 to −7 bp    | Mildly optimistic on volatile — inherent (legacy venue) |
| **odos** (V3) | untested\* | untested\*    | Uses `outAmounts[0]` (executable output) + protocol-fee-aware filtering — expected accurate |
| **matcha**  | untested\*  | untested\*     | 0x API account was suspended during testing |

\* Could not be exercised in the test environment at the time: Odos enterprise
quota was exhausted and the public endpoint is heavily rate-limited; the 0x key
returned "You cannot consume this service". (Both venues have since been
restored and are exercised by the e2e suite — only the bp-accuracy measurement
was never re-run.)

**curve** is exact because curve-js's `getBestRouteAndOutput` probes the pools'
on-chain `get_dy` directly — the quote *is* the on-chain output. Every pair
(stable and volatile) simulated to 0.0 bp.

**uniswap** routes are mostly `permit-tx` (V4 / split / mixed via the Universal
Router + Permit2), which `--simulate` can't run without a wallet-grade Permit2
signature — a synthetic-key sim reverts at the Permit2 `permit` command
(harness artifact, not a routing problem; it's a production-verified path the
dApp e2e suite covers). The one fast-path route that *is* sim-able (50k
DAI→USDC, SwapRouter02) came in at 0.0 bp. As a signature-free accuracy check,
Uniswap's quoted output was compared head-to-head against velora/1inch (proven
quote ≈ receipt) at the same instant: Uniswap was always **at or below** them
(e.g. USDC→USDT exactly = velora; 5 WETH→USDC 4.3 bp *below* velora), so its
quote never overstates the receivable.

A **baseline ~1–2 bp** drift affects *every* venue because the simulation runs
a moment after the quote (block/price moves on); velora & 1inch landing on ~0
shows there is no hidden fee in the well-behaved venues — the user's
impression came from the venues below.

## The OpenOcean bug (fixed)

OpenOcean's `/v4/.../quote` returns `outAmount` as a **mid-price estimate that
does not fold in the route's price impact**. The execution actually delivers
`outAmount × (1 + price_impact/100)`, and OpenOcean returns that `price_impact`
in the same response — we were discarding it. Evidence: a reported `-0.01%`
impact on 10k USDC→USDT matched the −0.01% simulated shortfall *to the wei*.

Because every other aggregator already bakes impact into its quoted output,
OpenOcean was the lone venue whose headline number overstated the receivable —
which also **inflated its rank** in `-v all` (pickBest sorts on gross
`amountOut`), so a user picking "the best" could receive less than the
runner-up actually delivers.

**Fix** (`src/venues/openocean.ts`, `applyPriceImpact`): fold `price_impact`
into the normalized `amountOut` so the displayed/ranked number equals the
executable receivable. Guard rails — only ever *reduce* (never inflate on a
positive impact), and bail to the raw figure on an unparseable/implausible
value. Result: OpenOcean's median quote-vs-received bias moved from a
consistent **~−10 bp to ~0**, exact on stable pairs.

On some volatile routes OpenOcean *understates* its own `price_impact` (reports
`+0.02%` while execution loses ~10 bp), so the correction only removes the part
it admits to; the residual is then in line with the other aggregators'
volatile-pair estimate error and is symmetric (noise, not bias).

## The Curve `--json` leak (fixed)

Testing curve surfaced a separate bug: `buildTx`'s `curve.router.populateSwap`
call was **not** wrapped in the `console.log` silencer that `init` and
`getBestRouteAndOutput` use, so curve-js printed its arguments
(`<in> <out> <amount> <slippage>`) straight to **stdout**, ahead of the JSON
object. That corrupts `swap … -v curve --json` output (and any downstream JSON)
consumer / dApp server path). Fix (`src/venues/curve.ts`): wrap `populateSwap`
in the same save/silence/restore-in-`finally` pattern. Curve's quote itself was
always correct (0.0 bp) — this was purely output hygiene.

## Not fixed (inherent)

`kyber` and `odosv2` quote a few bp optimistically on volatile pairs. Their
`amountOut` *is* meant to be the executable output (the build reuses the exact
same route), so the gap is genuine off-chain pricing-engine imprecision with no
field to recover it — correcting it would require simulating every quote, which
the dApp deliberately avoids (per-visitor RPC quota). Documented here so the
small residual is understood rather than mistaken for a new fee.

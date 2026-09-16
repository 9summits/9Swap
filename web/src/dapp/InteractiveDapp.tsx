import React from "react";
import { useAccount, useConnect } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { IconKeyframes, Icon } from "./icons";
import { Header } from "./Header";
import { SiteFooter } from "./SiteFooter";
import { FeedbackWidget } from "./FeedbackWidget";
import { SwapForm } from "./SwapForm";
import { RoutesPane } from "./RoutesPane";
import { RouteGraph } from "./RouteGraph";
import { TokenSelector } from "./TokenSelector";
import { useQuote, shouldHoldQuotes, NATIVE_SENTINEL, toBaseUnits } from "./useQuote";
import { getTokens, postBuild, postRoute, resolveToken } from "./api";
import { readUrlState, writeUrlState } from "./urlState";
import { curveSupportedChain, buildCurve } from "./curve/client";
import { listCustomTokens } from "./customTokens";
import { listRecentTokens } from "./recentTokens";
import { collectBalanceTargets, type BalanceMap } from "./tokenHoldings";
import { readWalletBalances } from "./walletBalances";
import { erc20Abi, type EIP1193Provider } from "viem";
import { publicClientFor, useDisconnectCompletion } from "../wagmi";
import { vmeta } from "./venues";
import { SendTx, type SendTxRun } from "../SendTx";
import { orderExplorerCtaLabel } from "../cowExplorer";
import { SignOrder } from "../SignOrder";
import { SignPermitTx } from "../SignPermitTx";
import type { Payload } from "../payload";
import type {
  ApiMode,
  ChainMeta,
  RouteGraphResponse,
  TokenInfo,
  VenueMeta,
  WireTokenInfo,
} from "./types";

// <InteractiveDapp> — the orchestrator for the live two-pane swap dApp.
//
// Holds all form state (chain, pair, amount, slippage, venue filters, send
// recipient), the selected venue, the connected wallet (wagmi useAccount), and
// the build/execution state. Renders the Header, the two-pane grid (SwapForm
// left, RoutesPane right) and, once the user hits Swap/Send, builds a Payload
// via /api/build and hands it to the EXISTING execution components
// (<SendTx>/<SignOrder>/<SignPermitTx>) — unchanged — which drive approve/sign/
// send and report back via /done. On success it shows an explorer link and a
// "new swap" reset.

// Copy-CLI extras persisted from Settings. Corrupt / missing → these defaults
// (json off, -d on, simu off). `simu` forces `data` on: simulate needs a built tx.
const CLI_COPY_FLAGS_KEY = "swap.cliCopyFlags.v1";
type CliCopyFlags = { json: boolean; data: boolean; simu: boolean };
const DEFAULT_CLI_COPY_FLAGS: CliCopyFlags = { json: false, data: true, simu: false };

function loadCliCopyFlags(): CliCopyFlags {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_CLI_COPY_FLAGS };
    const raw = localStorage.getItem(CLI_COPY_FLAGS_KEY);
    if (!raw) return { ...DEFAULT_CLI_COPY_FLAGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CLI_COPY_FLAGS };
    const o = parsed as Record<string, unknown>;
    const json = typeof o.json === "boolean" ? o.json : DEFAULT_CLI_COPY_FLAGS.json;
    const simu = typeof o.simu === "boolean" ? o.simu : DEFAULT_CLI_COPY_FLAGS.simu;
    const data =
      (typeof o.data === "boolean" ? o.data : DEFAULT_CLI_COPY_FLAGS.data) || simu;
    return { json, data, simu };
  } catch (e) {
    console.error("InteractiveDapp: failed to read CLI copy flags", e);
    return { ...DEFAULT_CLI_COPY_FLAGS };
  }
}

// Which side of the pair the token selector is editing.
type PickSide = "in" | "out" | null;

// The build/execution lifecycle.
type ExecState =
  | { phase: "idle" }
  | { phase: "building" }
  | { phase: "error"; message: string }
  | { phase: "ready"; payload: Payload };

export function InteractiveDapp({ mode, sid }: { mode: ApiMode; sid: string }) {
  // ---- chains / venues from /api/mode ----
  const chains = mode.chains;

  // Deep-link state parsed once from the URL query (chain, pair, amount, venue
  // filter, slippage). Drives the initial state below; thereafter the write
  // effect keeps the URL in sync. Captured once so later URL writes can't feed
  // back into init.
  const [urlInit] = React.useState(readUrlState);

  const initialChain =
    (urlInit.chain && chains.find((c) => c.alias === urlInit.chain)) ||
    chains.find((c) => c.alias === mode.defaultChain) ||
    chains[0];

  const [chain, setChain] = React.useState<ChainMeta>(initialChain);

  // The server omits curve when it can't run it (Vercel stateless deploy with
  // SWAP_DISABLE_VENUES=curve — curve-js's ~12s on-chain init can't survive a
  // serverless cold start). When it's absent we quote curve IN THE BROWSER via
  // @curvefi/api (the visitor pays the init once per tab with their own RPC).
  const serverHasCurve = React.useMemo(
    () => mode.venues.some((v) => v.name === "curve"),
    [mode.venues],
  );
  // When the server doesn't offer curve and the current chain is curve-
  // supported, add a synthetic curve VenueMeta so the SettingsPopover toggle
  // exists and `enabledVenues` can carry it. (When the server DOES offer curve,
  // or the chain is unsupported, the list is just mode.venues — no duplicate.)
  const venues: VenueMeta[] = React.useMemo(() => {
    if (serverHasCurve || !curveSupportedChain(chain.chainId)) return mode.venues;
    return [...mode.venues, { name: "curve", kind: "sync" as const }];
  }, [mode.venues, serverHasCurve, chain.chainId]);

  // ---- pair ----
  const [tokenIn, setTokenIn] = React.useState<TokenInfo | null>(null);
  const [tokenOut, setTokenOut] = React.useState<TokenInfo | null>(null);
  const [pickSide, setPickSide] = React.useState<PickSide>(null);

  // ---- amount + edit side + send recipient ----
  // `amount` is the single active amount the user typed; `editSide` says which
  // field it denominates: "pay" → exact-in (sell), "receive" → exact-out (buy).
  // Deep links restore an amount only in the default pay (sell) mode.
  const [amount, setAmount] = React.useState(urlInit.amount ?? "");
  const [editSide, setEditSide] = React.useState<"pay" | "receive">("pay");
  const [isSend, setIsSend] = React.useState(false);
  const [recipient, setRecipient] = React.useState("");

  // ---- settings ----
  const [slippageBps, setSlippageBps] = React.useState(urlInit.slippageBps ?? 10);
  // Intent/async venues (CoW, UniswapX, Velora Delta, 1inch Fusion) are
  // included by default — they often win on larger trades.
  const [allowAsync, setAllowAsync] = React.useState(true);
  // Copy-CLI extras (Settings). Persist across visits; simu forces data on.
  const [cliCopyFlags, setCliCopyFlags] = React.useState(loadCliCopyFlags);
  const { json: cliJson, data: cliData, simu: cliSimu } = cliCopyFlags;
  React.useEffect(() => {
    try {
      localStorage.setItem(CLI_COPY_FLAGS_KEY, JSON.stringify(cliCopyFlags));
    } catch (e) {
      console.error("InteractiveDapp: failed to persist CLI copy flags", e);
    }
  }, [cliCopyFlags]);
  function onCliJson(v: boolean) {
    setCliCopyFlags((f) => ({ ...f, json: v }));
  }
  function onCliData(v: boolean) {
    setCliCopyFlags((f) => ({ ...f, data: v, simu: v ? f.simu : false }));
  }
  function onCliSimu(v: boolean) {
    setCliCopyFlags((f) => ({ ...f, simu: v, data: v ? true : f.data }));
  }
  const allVenueNames = React.useMemo(() => venues.map((v) => v.name), [venues]);
  const [enabledVenues, setEnabledVenues] = React.useState<string[]>(() => {
    // Restore the URL venue filter (intersected with what's available); absent
    // or all-bogus ⇒ every venue on.
    const fromUrl = urlInit.venues?.filter((v) => allVenueNames.includes(v));
    return fromUrl && fromUrl.length ? fromUrl : allVenueNames;
  });

  // Reconcile enabledVenues with the venue list when it changes shape. The
  // synthetic curve venue appears/disappears as the chain switches (and the
  // server set is otherwise fixed), so a venue that newly EXISTS but the user
  // never explicitly toggled off defaults to ON — i.e. curve is enabled by
  // default the moment we land on a curve-supported chain. Venues that vanished
  // from the list are pruned so the on/off count math stays exact.
  const prevVenueNamesRef = React.useRef<string[] | null>(null);
  React.useEffect(() => {
    const prevAll = prevVenueNamesRef.current;
    prevVenueNamesRef.current = allVenueNames;
    // First run: keep the initial selection as-is (URL filter or all). We must
    // NOT treat every venue as "newly added" here, or a URL-restored subset
    // would be blown back up to all.
    if (prevAll === null) return;
    const present = new Set(allVenueNames);
    // Only venues that genuinely just appeared in the list (e.g. curve when the
    // chain becomes curve-supported) default to ON. A venue the user/URL left
    // off — present both before and after — stays off.
    const newlyAdded = allVenueNames.filter((v) => !prevAll.includes(v));
    setEnabledVenues((prev) => {
      const kept = prev.filter((v) => present.has(v));
      const toAdd = newlyAdded.filter((v) => !kept.includes(v));
      if (toAdd.length === 0 && kept.length === prev.length) return prev; // no change
      return [...kept, ...toAdd];
    });
  }, [allVenueNames]);

  // ---- selected venue (defaults to best; user can override via routes pane) ----
  const [selectedVenue, setSelectedVenue] = React.useState<string | null>(null);

  // Pair live map (tokenIn/tokenOut, block watcher) and picker snapshot
  // (curated+custom+recent, Multicall3). Merged at read; pair keys win.
  const [pairBalances, setPairBalances] = React.useState<BalanceMap | null>(null);
  const [portfolioBalances, setPortfolioBalances] =
    React.useState<BalanceMap | null>(null);
  const balances = React.useMemo<BalanceMap | null>(() => {
    if (!pairBalances && !portfolioBalances) return null;
    return { ...(portfolioBalances ?? {}), ...(pairBalances ?? {}) };
  }, [pairBalances, portfolioBalances]);

  // ---- wallet ----
  const { address, chainId: walletChainId, connector, status } = useAccount();
  const { connect, connectors } = useConnect();
  useDisconnectCompletion();
  const connected = !!address;
  // RainbowKit's modal opener (undefined while already connected / mid-open).
  const { openConnectModal } = useConnectModal();

  // Inside a Safe App iframe the user never gets to click Connect, so we do it
  // for them. wagmi's own reconnect() is not enough: the safe connector's
  // isAuthorized() swallows the getInfo timeout in a bare catch and answers
  // false, so a first load inside the Safe would otherwise stay disconnected.
  // wagmi starts at "disconnected" BEFORE reconnect() runs (child effects fire
  // first), so wait for the connecting/reconnecting pass to settle: connecting
  // in parallel with it would spin up two Safe SDK instances on one frame.
  const safeAutoConnectFired = React.useRef(false);
  const reconnectSeen = React.useRef(false);
  React.useEffect(() => {
    if (status === "connecting" || status === "reconnecting") {
      reconnectSeen.current = true;
      return;
    }
    if (status !== "disconnected" || !reconnectSeen.current) return;
    if (safeAutoConnectFired.current) return;
    if (typeof window === "undefined" || window.parent === window) return;
    const safeConnector = connectors.find((c) => c.id === "safe");
    if (!safeConnector) return;
    safeAutoConnectFired.current = true;
    connect({ connector: safeConnector });
  }, [status, connectors, connect]);

  // The Safe picks the network, not us: mirror its chain into the form so the
  // quote and the built tx target what the Safe can actually execute.
  const chainLocked = connector?.id === "safe";
  React.useEffect(() => {
    if (!chainLocked || typeof walletChainId !== "number") return;
    setChain((current) => {
      if (current.chainId === walletChainId) return current;
      return chains.find((c) => c.chainId === walletChainId) ?? current;
    });
  }, [chainLocked, walletChainId, chains]);

  // ---- execution ----
  const [exec, setExec] = React.useState<ExecState>({ phase: "idle" });
  // Live step reported by SendTx / SignOrder / SignPermitTx so the action
  // button mirrors approve → swap → done instead of spinning forever.
  const [execRun, setExecRun] = React.useState<SendTxRun | null>(null);
  // Venue captured at Swap click. While quotes are held, the routes pane
  // keeps highlighting this row even if a late stream event would have
  // moved `best`.
  const [heldVenue, setHeldVenue] = React.useState<string | null>(null);

  // ---- route graph (the selected venue's hops, for the graphical view) ----
  const [routeGraph, setRouteGraph] = React.useState<RouteGraphResponse | null>(
    null,
  );
  // Mirror for the freeze-while-streaming guard (avoids putting routeGraph in
  // the postRoute effect deps, which would re-fire on every successful fetch).
  const routeGraphRef = React.useRef(routeGraph);
  routeGraphRef.current = routeGraph;
  const [routeLoading, setRouteLoading] = React.useState(false);

  // -------------------------------------------------------------------------
  // Seed a sensible default pair when the chain changes (first two curated
  // tokens — typically native + a stable). Best-effort: failures are logged,
  // the user can still pick manually.
  // -------------------------------------------------------------------------
  // Per-chain default pair (symbols looked up in the curated list). Chains
  // absent from this table keep the generic rule (USDT-ish in, native out).
  const DEFAULT_PAIR: Record<string, { in: string; out: string }> = {
    arc: { in: "USDC", out: "EURC" },
    robinhood: { in: "USDG", out: "TSLA" },
    monad: { in: "USDC", out: "MON" },
    plasma: { in: "USDT0", out: "XPL" },
    polygon: { in: "USDC", out: "WETH" },
    gnosis: { in: "USDC.e", out: "GNO" },
    ink: { in: "USDC", out: "ETH" },
  };
  const firstTokenLoadRef = React.useRef(true);
  React.useEffect(() => {
    let cancelled = false;
    const first = firstTokenLoadRef.current;
    firstTokenLoadRef.current = false;
    // On a real chain SWITCH, reset the pair + transient state. On the initial
    // mount we must NOT clear the amount (the URL may have provided one), and
    // the pair is restored from the URL below.
    if (!first) {
      setTokenIn(null);
      setTokenOut(null);
      setAmount("");
      setEditSide("pay"); // back to the default exact-in mode on a chain switch
      setPairBalances(null);
      setPortfolioBalances(null);
      setSelectedVenue(null);
      setExec({ phase: "idle" });
      setExecRun(null);
      setHeldVenue(null);
    }
    getTokens(sid, chain.alias)
      .then(async (list) => {
        if (cancelled || list.length === 0) return;
        // Default pair: per-chain override when present (robinhood → USDG/
        // TSLA), otherwise a stablecoin (USDT preferred) in, native out.
        const native =
          list.find((t) => t.address.toLowerCase() === NATIVE_SENTINEL) ??
          list[0];
        const stable =
          list.find((t) => t.symbol?.toUpperCase() === "USDT") ??
          list.find(
            (t) => t.address.toLowerCase() !== native.address.toLowerCase(),
          ) ??
          null;
        const pref = DEFAULT_PAIR[chain.alias];
        const bySymbol = (sym: string) =>
          list.find((t) => t.symbol?.toUpperCase() === sym.toUpperCase()) ?? null;
        const defIn = (pref && bySymbol(pref.in)) ?? stable;
        const defOut = (pref && bySymbol(pref.out)) ?? native;
        // First load with URL tokens → restore that pair (resolving any address
        // not already in the curated list); otherwise the default pair.
        if (first && (urlInit.tokenIn || urlInit.tokenOut)) {
          const resolve = async (addr: string | null) => {
            if (!addr) return null;
            const hit = list.find(
              (t) => t.address.toLowerCase() === addr.toLowerCase(),
            );
            if (hit) return hit;
            // Deep link to a locally-stored custom token: the server resolver
            // has no record of it, localStorage does.
            const custom = listCustomTokens(chain.chainId).find(
              (t) => t.address.toLowerCase() === addr.toLowerCase(),
            );
            if (custom) return custom;
            try {
              return await resolveToken(sid, chain.alias, addr);
            } catch (e) {
              console.error("InteractiveDapp: URL token resolve failed", addr, e);
              return null;
            }
          };
          const [ri, ro] = await Promise.all([
            resolve(urlInit.tokenIn),
            resolve(urlInit.tokenOut),
          ]);
          if (cancelled) return;
          setTokenIn(ri ?? defIn);
          setTokenOut(ro ?? defOut);
        } else {
          setTokenIn(defIn);
          setTokenOut(defOut);
        }
      })
      .catch((e) => {
        console.error("InteractiveDapp: getTokens (default pair) failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, [chain.alias, sid]);

  // -------------------------------------------------------------------------
  // Mirror the shareable swap state into the URL query (chain, pair, amount,
  // venue filter, slippage), preserving the session `id`. venues is omitted
  // when every venue is on (the "all" default). replaceState → no history spam.
  // -------------------------------------------------------------------------
  React.useEffect(() => {
    const allOn = allVenueNames.every((v) => enabledVenues.includes(v));
    writeUrlState({
      chain: chain.alias,
      tokenIn: tokenIn?.address ?? null,
      tokenOut: tokenOut?.address ?? null,
      amount: amount || null,
      venues: allOn ? null : enabledVenues,
      slippageBps,
    });
  }, [
    chain.alias,
    tokenIn?.address,
    tokenOut?.address,
    amount,
    enabledVenues,
    slippageBps,
    allVenueNames,
  ]);

  // -------------------------------------------------------------------------
  // Load balances for the active pair whenever the wallet connects or the pair
  // / chain changes, then keep them LIVE: a watchBlockNumber subscription
  // refetches on every new block, and the post-tx effect below forces an
  // immediate refetch once a swap confirms. Best-effort — a balance failure
  // just hides the MAX button.
  // -------------------------------------------------------------------------
  // Out-of-effect refresh trigger (post-tx). A ref — not state — so invoking
  // it can never restart the watcher effect below.
  const refetchBalancesRef = React.useRef<(() => void) | null>(null);
  // Which account the balances map belongs to (lowercased) — an account switch
  // must replace the map, not merge into the previous account's entries.
  const balancesOwnerRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!address) {
      setPairBalances(null);
      return;
    }
    const toks = [tokenIn, tokenOut].filter((t): t is TokenInfo => !!t);
    if (toks.length === 0) return;
    let cancelled = false;
    let unwatch: (() => void) | null = null;
    // A block tick and the post-tx trigger can coincide; running both would
    // race their setPairBalances, so overlapping refetches are dropped (the next
    // tick re-reads anyway).
    let inFlight = false;
    (async () => {
      // Client-side reads — the server's RPC key is never consumed for
      // per-visitor balance lookups. Go through the CONNECTED wallet's
      // provider (connector.getProvider(), NOT window.ethereum: with several
      // extensions that global may be another wallet on another chain) and
      // only when it sits on the selected chain; otherwise publicClientFor
      // falls back to the chain's default public RPC.
      let walletProvider: EIP1193Provider | undefined;
      if (walletChainId === chain.chainId && connector?.getProvider) {
        walletProvider = (await connector
          .getProvider()
          .catch(() => undefined)) as EIP1193Provider | undefined;
      }
      // Deps may have changed while suspended on getProvider — bail before
      // assigning the ref below, or this dead run's closure (whose refetch
      // no-ops on `cancelled`) would overwrite the live run's.
      if (cancelled) return;
      const client = publicClientFor(chain.chainId, walletProvider);
      if (!client) {
        console.warn(`InteractiveDapp: no public client for chain ${chain.alias}`);
        if (!cancelled) setPairBalances(null);
        return;
      }
      const refetch = async () => {
        if (inFlight || cancelled) return;
        inFlight = true;
        try {
          // Per-token reads settle independently — a failing tokenOut (e.g. a
          // transient wrong-chain lookup) must not take the tokenIn balance
          // (and its MAX button) down with it.
          const results = await Promise.allSettled(
            toks.map(async (t) => {
              const bal =
                t.address.toLowerCase() === NATIVE_SENTINEL
                  ? await client.getBalance({ address })
                  : await client.readContract({
                      address: t.address as `0x${string}`,
                      abi: erc20Abi,
                      functionName: "balanceOf",
                      args: [address],
                    });
              // Keys lowercased so SwapForm/TokenSelector lookups hit.
              return [t.address.toLowerCase(), bal.toString()] as const;
            }),
          );
          if (cancelled) return;
          const entries: (readonly [string, string])[] = [];
          results.forEach((r, i) => {
            if (r.status === "fulfilled") entries.push(r.value);
            else console.error(`InteractiveDapp: balance read failed for ${toks[i]!.symbol}`, r.reason);
          });
          // MERGE into the previous map, never replace wholesale: the stale
          // values keep rendering while a refetch is in flight (no flicker),
          // and a token whose read failed this round keeps its last good
          // value instead of losing its MAX button. Exception: the map holds
          // ONE account's balances — on a wallet account switch the previous
          // account's entries must be flushed, not merged over (they'd render
          // the old account's balance for any token outside the current pair).
          const sameOwner = balancesOwnerRef.current === address.toLowerCase();
          balancesOwnerRef.current = address.toLowerCase();
          if (entries.length > 0) {
            setPairBalances((prev) =>
              sameOwner
                ? { ...(prev ?? {}), ...Object.fromEntries(entries) }
                : Object.fromEntries(entries),
            );
          } else if (!sameOwner) {
            setPairBalances(null);
          }
        } finally {
          inFlight = false;
        }
      };
      refetchBalancesRef.current = () => void refetch();
      await refetch();
      if (cancelled) return;
      // Everything refetch closes over (toks, address, client) is pinned by
      // this effect's deps, so the watcher callback can't go stale — any dep
      // change tears the subscription down first via cleanup.
      unwatch = client.watchBlockNumber({
        onBlockNumber: () => void refetch(),
        onError: (e) => console.warn("InteractiveDapp: balance block watcher error", e),
        pollingInterval: 4000,
      });
    })();
    return () => {
      cancelled = true;
      refetchBalancesRef.current = null;
      unwatch?.();
    };
  }, [address, walletChainId, connector, chain.chainId, chain.alias, tokenIn, tokenOut]);

  // Picker snapshot: curated + custom + recent via Multicall3. Not on the
  // block watcher — one shot on connect, picker open, and post-tx.
  const refetchPortfolioRef = React.useRef<(() => void) | null>(null);
  const portfolioOwnerRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!address) {
      setPortfolioBalances(null);
      portfolioOwnerRef.current = null;
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let queued = false;
    const run = async () => {
      if (cancelled) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        let walletProvider: EIP1193Provider | undefined;
        if (walletChainId === chain.chainId && connector?.getProvider) {
          walletProvider = (await connector
            .getProvider()
            .catch(() => undefined)) as EIP1193Provider | undefined;
        }
        if (cancelled) return;
        let curated: TokenInfo[] = [];
        try {
          curated = await getTokens(sid, chain.alias);
        } catch (e) {
          console.error("InteractiveDapp: portfolio getTokens failed", e);
        }
        if (cancelled) return;
        const tokens = collectBalanceTargets({
          curated,
          custom: listCustomTokens(chain.chainId),
          recent: listRecentTokens(chain.chainId),
        });
        const map = await readWalletBalances({
          chainId: chain.chainId,
          owner: address,
          tokens,
          walletProvider,
        });
        if (cancelled) return;
        const owner = address.toLowerCase();
        const sameOwner = portfolioOwnerRef.current === owner;
        portfolioOwnerRef.current = owner;
        setPortfolioBalances((prev) => (sameOwner ? { ...(prev ?? {}), ...map } : map));
      } catch (e) {
        console.error("InteractiveDapp: portfolio snapshot failed", e);
      } finally {
        inFlight = false;
        if (queued && !cancelled) {
          queued = false;
          void run();
        }
      }
    };
    refetchPortfolioRef.current = () => void run();
    void run();
    return () => {
      cancelled = true;
      refetchPortfolioRef.current = null;
    };
  }, [address, walletChainId, connector, chain.chainId, chain.alias, pickSide, sid]);

  // Immediate balance refresh once a tx lands — don't wait for the next
  // block-watcher tick. Receipt detection may have come from the public
  // backup poll (useTxReceipt) rather than the wallet RPC; a best-effort
  // refetch is still the right call either way. Keyed on the stage STRING
  // so a re-reported "done" run object doesn't refire; a fresh run resets
  // the stage through approve/swap first.
  React.useEffect(() => {
    if (execRun?.stage === "done") {
      refetchBalancesRef.current?.();
      refetchPortfolioRef.current?.();
    }
  }, [execRun?.stage]);

  // -------------------------------------------------------------------------
  // Quote lifecycle.
  // -------------------------------------------------------------------------
  // Freeze the ranked list while a tx is being built or the wallet is being
  // asked to approve/sign. A refresh here would change best venue under an
  // already-sent approve (Velora spender, then a swap on whoever won next).
  const quotesHeld = shouldHoldQuotes({
    execPhase: exec.phase,
    runStage: exec.phase === "ready" ? execRun?.stage : null,
  });
  const {
    quote,
    loading: quoteLoading,
    streaming: quoteStreaming,
    error: quoteError,
    mode: formMode,
    synthAmountOut,
    secondsToExpiry,
    refresh,
    refreshLocked,
    curveRouteHops,
  } = useQuote({
    chain,
    tokenIn,
    tokenOut,
    amount,
    editSide,
    slippageBps,
    allowAsync,
    enabledVenues,
    allVenueCount: venues.length,
    isSend,
    serverHasCurve,
    paused: quotesHeld,
  });

  // The EFFECTIVE venue follows the live best as routes stream in, UNLESS the
  // user has pinned one by clicking a route (selectedVenue) and it's still
  // present — or a swap is in flight, in which case the click-time venue
  // stays selected so a late stream event cannot retarget the UI.
  // Deriving it (rather than storing) avoids fighting the streaming
  // best — the pin is cleared on any quote-input change by the effect below.
  const effectiveVenue =
    quotesHeld && heldVenue
      ? heldVenue
      : selectedVenue && quote?.routes.some((r) => r.venue === selectedVenue)
        ? selectedVenue
        : quote?.best.venue ?? null;

  // The full route object for the effective venue (when present this round).
  // `clientSide` marks the in-browser curve route, which the build + route-
  // graph paths handle locally instead of via /api/build · /api/route.
  const effectiveRoute =
    quote?.routes.find((r) => r.venue === effectiveVenue) ?? null;
  const effectiveIsClientSide = !!effectiveRoute?.clientSide;
  // Intent (async) venues — cow / delta / uniswapx / fusion — settle off-chain
  // via a solver, so there is no on-chain route to draw. The route panel shows
  // an "intent" note instead of a (misleading) single-pool graph, and we skip
  // the /api/route re-quote entirely (it would burn the venue's API quota only
  // to produce hops we never render).
  const effectiveIsIntent = effectiveRoute?.kind === "async";

  // Exact-out is active only in a real swap with the receive field the input.
  // Drives the side-aware build + route-graph requests below.
  const buyMode = formMode === "swap" && editSide === "receive";

  // Clear the manual pin whenever the quote inputs change (a new quote round →
  // follow best again). Not keyed on selectedVenue, so a click sticks.
  React.useEffect(() => {
    setSelectedVenue(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.alias, tokenIn, tokenOut, amount, editSide, slippageBps, allowAsync, isSend]);

  // Fetch the effective venue's route graph (symbol-labelled hops) whenever the
  // quote round or the chosen venue changes. Debounced so the streaming best
  // flipping a few times doesn't fire a burst of /api/route calls. Cleared for
  // non-swap modes (wrap/unwrap/send have no aggregator routing).
  const routeHasVenue =
    formMode === "swap" &&
    !!effectiveVenue &&
    !!quote?.routes.some((r) => r.venue === effectiveVenue);
  // The route graph is sticky across same-venue re-quotes (amount slider / TTL)
  // so the sankey doesn't blink on every refresh. It is CLEARED when the
  // effective venue changes (user picks another row) so we never show venue A's
  // path while B is loading. Also dropped on pair/chain change or leaving swap.
  React.useEffect(() => {
    setRouteGraph(null);
  }, [chain.alias, tokenIn?.address, tokenOut?.address]);
  React.useEffect(() => {
    if (!routeHasVenue || !effectiveVenue) {
      // Only blank when routing genuinely ends (wrap/unwrap/send). In swap mode
      // keep the last graph across the transient gap; the pair/chain effect
      // above is what clears it on a real route change.
      if (formMode !== "swap") {
        setRouteGraph(null);
      }
      setRouteLoading(false);
      return;
    }
    // Freeze the left graph while a quote re-stream is in flight AND we're still
    // on the same venue as the sticky graph — progressive best flips would
    // otherwise re-fetch /api/route and thrash. If the user pinned a *different*
    // venue (or best moved off the sticky venue after stream), fall through and
    // clear + load the new path.
    const stickyVenue = routeGraphRef.current?.venue ?? null;
    if (
      quoteStreaming &&
      stickyVenue != null &&
      stickyVenue === effectiveVenue
    ) {
      setRouteLoading(false);
      return;
    }
    if (!tokenIn || !tokenOut) return;
    // Intent venue: no on-chain route. Set a synthetic graph (empty hops) so the
    // panel header still shows the pair; <RouteGraph intent> renders the "intent"
    // note in place of the sankey. No /api/route round-trip.
    if (effectiveIsIntent) {
      setRouteGraph({
        venue: effectiveVenue,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        hops: [],
      });
      setRouteLoading(false);
      return;
    }
    // Client-side curve route: the hops already came back with the quote (the
    // curve client returns RouteHop[] alongside amountOut), so build the graph
    // locally — no /api/route round-trip (the server can't quote curve here).
    if (effectiveIsClientSide) {
      if (curveRouteHops) {
        setRouteGraph({
          venue: "curve",
          tokenIn: tokenIn.symbol,
          tokenOut: tokenOut.symbol,
          hops: curveRouteHops,
        });
      } else if (stickyVenue != null && stickyVenue !== "curve") {
        // Switching onto curve before hops arrive — drop the previous venue's path.
        setRouteGraph(null);
      }
      setRouteLoading(false);
      return;
    }
    // Snapshot pair/amount for the async call. Prefer the quote round's
    // amountIn so the graph matches the routes being displayed — the raw
    // input field may already hold a newer value mid-typing, and that value
    // gets its own round (and graph re-fetch) when its stream completes.
    const snapTokenIn: WireTokenInfo = { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals, name: tokenIn.name };
    const snapTokenOut: WireTokenInfo = { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals, name: tokenOut.name };
    // Side-aware fixed leg: exact-out re-quotes the venue with amountOut+side so
    // the graph matches the routes shown; exact-in uses amountIn. Prefer the
    // quote round's resolved amount (the input field may hold a newer mid-typing
    // value that gets its own round). Sell-refine buy routes also send amountIn
    // (pay seed) so /api/route can re-quote as exact-in.
    const routeForGraph =
      quote?.routes.find((r) => r.venue === effectiveVenue) ?? quote?.routes[0];
    const snapAmounts = buyMode
      ? {
          amountOut:
            quote?.amountOut ?? toBaseUnits(amount, tokenOut.decimals) ?? "0",
          side: "buy" as const,
          ...(routeForGraph?.buyRefine && routeForGraph.amountIn
            ? { amountIn: routeForGraph.amountIn }
            : {}),
        }
      : { amountIn: quote?.amountIn ?? toBaseUnits(amount, tokenIn.decimals) ?? "0" };
    let cancelled = false;
    // Venue changed → blank the old path immediately (spinner + "Resolving…").
    // Same venue re-quote → keep sticky graph until the new one lands.
    if (stickyVenue != null && stickyVenue !== effectiveVenue) {
      setRouteGraph(null);
    }
    setRouteLoading(true);
    const handle = setTimeout(() => {
      postRoute(sid, {
        chain: chain.alias,
        venue: effectiveVenue,
        ...snapAmounts,
        slippageBps,
        tokenIn: snapTokenIn,
        tokenOut: snapTokenOut,
      })
        .then((g) => {
          if (!cancelled) setRouteGraph(g);
        })
        .catch((e) => {
          // Keep the last good graph on a transient fetch failure only when it
          // still matches the requested venue; otherwise leave empty (loading
          // already cleared the mismatched path).
          console.error("InteractiveDapp: postRoute failed", e);
          if (!cancelled && routeGraphRef.current?.venue !== effectiveVenue) {
            // already cleared or never set — nothing to restore
          }
        })
        .finally(() => {
          if (!cancelled) setRouteLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  // Keyed on the quote ROUND (quoteId), not the raw amount/slippage inputs:
  // /api/route re-quotes the venue server-side, so firing it per keystroke
  // would burn venue API quota. A new round (which any input change produces
  // via useQuote) or a venue change is what refreshes the graph.
  // effectiveIsClientSide + curveRouteHops are added so the curve branch
  // re-runs when curve's hops arrive (often AFTER the round's quoteId is set,
  // since curve-js init is slow) and when the effective route flips to/from the
  // client-side curve row.
  // quoteStreaming freezes re-fetch while a re-stream is in flight (see early
  // return above); included so the graph updates once the round settles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, effectiveVenue, routeHasVenue, quote?.quoteId, effectiveIsClientSide, effectiveIsIntent, curveRouteHops, quoteStreaming]);

  // Any form change or connected-account switch invalidates a built-but-not-
  // executed payload. sender is frozen into calldata / Permit2 / the order at
  // build time; a later wallet switch must not keep that payload executable.
  React.useEffect(() => {
    setExec((prev) => (prev.phase === "ready" ? { phase: "idle" } : prev));
    setExecRun(null);
    setHeldVenue(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chain.alias,
    tokenIn,
    tokenOut,
    amount,
    editSide,
    slippageBps,
    isSend,
    recipient,
    selectedVenue,
    allowAsync,
    address,
  ]);

  // -------------------------------------------------------------------------
  // Handlers.
  // -------------------------------------------------------------------------
  function onFlip() {
    if (isSend) return; // no "receive" side in send mode
    // Flip semantics (PR7 §dApp #5): swap the tokens and keep the ACTIVE field's
    // amount AND the edit side unchanged — the least surprising behaviour. The
    // typed number stays put; only the pair (and thus the quote) changes. So
    // "pay 1 A → receive ?" becomes "pay 1 B → receive ?" (still exact-in), and
    // "receive 5 A (pay ≈)" becomes "receive 5 B (pay ≈)" (still exact-out). The
    // now-derived opposite side re-fills from the fresh quote.
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setSelectedVenue(null);
  }

  // Toggle a single venue on/off — sync and intent (async) venues alike are
  // controlled individually. (The global "Intent" toggle in the RoutesPane
  // header is the separate group on/off for all async venues at once.)
  function onToggleVenue(name: string) {
    setEnabledVenues((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name],
    );
  }

  // Enable or disable every venue at once (the "all / none" button in settings).
  function onSetAllVenues(on: boolean) {
    setEnabledVenues(on ? allVenueNames : []);
  }

  function onSelectToken(token: TokenInfo) {
    if (pickSide === "in") {
      // Avoid in==out collision by flipping if the user picks the other side.
      if (tokenOut && token.address.toLowerCase() === tokenOut.address.toLowerCase()) {
        setTokenOut(tokenIn);
      }
      setTokenIn(token);
    } else if (pickSide === "out") {
      if (tokenIn && token.address.toLowerCase() === tokenIn.address.toLowerCase()) {
        setTokenIn(tokenOut);
      }
      setTokenOut(token);
    }
    setSelectedVenue(null);
  }

  // Build the payload for the chosen venue/mode, then drop into the matching
  // execution component. The connected wallet is the sender (no --from).
  async function onAction() {
    if (!address) return;
    setExecRun(null); // clear any prior run's reported phase before rebuilding
    // Determine which venue to build. For wrap/unwrap/send the backend returns
    // the right venue regardless; we still pass the selected (or best) venue.
    const venue =
      formMode === "swap"
        ? effectiveVenue ?? quote?.best.venue ?? ""
        : formMode === "send"
          ? "send"
          : "wrap";
    if (!quote && formMode === "swap") return;

    if (!tokenIn || !tokenOut) return;
    // The ACTIVE amount in base units: tokenIn on sell, tokenOut on buy.
    const activeToken = buyMode ? tokenOut : tokenIn;
    const buildAmount = toBaseUnits(amount, activeToken.decimals);
    if (!buildAmount) return;
    setHeldVenue(venue || null);
    // Native buy: amountOut + side. Sell-refine buy: amountOut + amountIn (pay
    // seed from the selected route) + side so the server rebuilds as exact-in
    // with min-out ≥ target. Sell: amountIn only.
    const selectedRoute =
      quote?.routes.find((r) => r.venue === venue) ?? quote?.routes[0];
    const buildAmountFields = buyMode
      ? {
          amountOut: buildAmount,
          side: "buy" as const,
          ...(selectedRoute?.buyRefine && selectedRoute.amountIn
            ? { amountIn: selectedRoute.amountIn }
            : {}),
        }
      : { amountIn: buildAmount };
    const wireTokenIn: WireTokenInfo = { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals, name: tokenIn.name };
    const wireTokenOut: WireTokenInfo = { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals, name: tokenOut.name };

    // Client-side curve route: build entirely in the browser via buildCurve()
    // (it re-quotes for freshness + does the allowance check + approve tx
    // locally), never hitting /api/build. Errors surface through the SAME exec
    // path as postBuild failures. curve is sell-only here, so buildAmount is the
    // tokenIn amount (buyMode never selects a client-side curve route).
    if (formMode === "swap" && effectiveIsClientSide) {
      setExec({ phase: "building" });
      try {
        // Same provider rule as the balance effect: connector.getProvider()
        // only when the wallet is already on this chain.
        let walletProvider: EIP1193Provider | undefined;
        if (walletChainId === chain.chainId && connector?.getProvider) {
          walletProvider = (await connector
            .getProvider()
            .catch(() => undefined)) as EIP1193Provider | undefined;
        }
        const payload = await buildCurve({
          chainId: chain.chainId,
          chainMeta: {
            chainId: chain.chainId,
            name: chain.name,
            explorer: chain.explorer,
            nativeSymbol: chain.nativeSymbol,
          },
          tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
          tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
          amountIn: buildAmount,
          slippageBps,
          sender: address,
          walletProvider,
        });
        setExec({ phase: "ready", payload });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("InteractiveDapp: buildCurve failed", e);
        setExec({ phase: "error", message: msg });
      }
      return;
    }

    setExec({ phase: "building" });
    try {
      const payload = await postBuild(sid, {
        // Stateless contract: the server re-quotes fresh from these fields.
        // No quoteId — the handler does not read a server-side cache.
        venue,
        sender: address,
        recipient: formMode === "send" ? recipient.trim() : undefined,
        slippageBps,
        chain: chain.alias,
        tokenIn: wireTokenIn,
        tokenOut: wireTokenOut,
        ...buildAmountFields,
      });
      setExec({ phase: "ready", payload });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("InteractiveDapp: postBuild failed", e);
      setExec({ phase: "error", message: msg });
    }
  }

  function resetForNewSwap() {
    // Just dismiss the exec/error pane and keep the current quote (no flush) —
    // the live quote keeps auto-refreshing on its own.
    setExec({ phase: "idle" });
    setExecRun(null);
    setHeldVenue(null);
    setRecipient("");
  }

  // Open RainbowKit's connect modal directly via its hook. (The old DOM hack
  // clicked the first button inside the header — which is the chain selector,
  // not the connect button — so the in-form "Connect Wallet" opened the chain
  // dropdown instead of the wallet modal.)
  function openConnect() {
    openConnectModal?.();
  }

  // The routes-pane "no routing" note for wrap/unwrap/send.
  const noRouteNote =
    formMode === "swap" ? null : (
      <NoRouteNote mode={formMode} venueLabel={vmeta(formMode === "send" ? "send" : "wrap").label} />
    );

  // ---- action-button state, driven by the build phase + the live SendTx run ----
  // This is what fixes the "spinner forever" bug: once execRun reaches "done"
  // the button leaves its busy state, and it surfaces the approve leg explicitly.
  const actionVerb =
    formMode === "send"
      ? "Sent"
      : formMode === "wrap"
        ? "Wrapped"
        : formMode === "unwrap"
          ? "Unwrapped"
          : "Swap confirmed";
  let actionBusy = false;
  let actionDone = false;
  let actionLabel: string | undefined;
  let actionHref: string | undefined;
  if (exec.phase === "building") {
    actionBusy = true;
    actionLabel = "Building…";
  } else if (exec.phase === "ready") {
    const r = execRun;
    if (r?.stage === "done") {
      if (r.explorerUrl) {
        actionLabel = orderExplorerCtaLabel(r.explorerUrl);
        actionHref = r.explorerUrl;
      } else if (exec.payload.kind === "order") {
        actionDone = true;
        actionLabel = "Order submitted";
      } else {
        actionDone = true;
        actionLabel = actionVerb;
      }
    } else if (r?.stage === "error") {
      // Leave the button enabled for a fresh attempt; the exec panel below shows
      // the error + an inline retry.
      actionLabel = undefined;
    } else if (r?.stage === "approve") {
      actionBusy = true;
      const sym = tokenIn?.symbol ?? "token";
      actionLabel = r.confirming
        ? `Approving ${sym}…`
        : r.pending
          ? "Confirm approval in your wallet…"
          : `Approve ${sym}`;
    } else if (r?.stage === "queued") {
      // The batch is with the wallet (a Safe may need more owner signatures),
      // so the button stays enabled: starting another swap is legitimate.
      actionBusy = false;
      actionDone = false;
      actionLabel = "Batch queued · waiting for execution";
    } else {
      // swap leg (or run not yet reported)
      actionBusy = true;
      actionLabel = r?.confirming
        ? "Waiting for confirmation…"
        : "Confirm in your wallet…";
    }
  }

  return (
    <div style={d.app} data-dapp-root>
      {/* index.html caps #root at max-width:720px for the legacy sign-only page.
          The interactive dApp is full-bleed, so reset that while it's mounted. */}
      <style>{`#root{max-width:none;width:100%;margin:0;padding:0;}
        /* Reserve the vertical scrollbar lane so quote height changes (slider
           re-quotes, streaming routes) never show/hide the bar and shove the
           three columns sideways. */
        html{scrollbar-gutter:stable;}
        /* ponytail: mobile = single stacked column; desktop (>900px) untouched.
           Inline styles need !important to override; swap card stays on top. */
        @media (max-width:900px){
          /* clip horizontal at the root so no row can ever scroll the page. */
          [data-dapp-root]{overflow-x:clip;}
          [data-dapp-header-inner]{padding:0 14px !important;}
          /* shrink the header to fit a phone: chain pill → icon only, drop the
             brand subtitle (the wide Connect Wallet button needs the room). */
          [data-chain-name]{display:none;}
          [data-brand-sub]{display:none;}
          /* brand + wallet row has no room for a second pill on a phone; the
             info stays reachable via the footer's Disclaimer link. */
          [data-privacy-pill]{display:none !important;}
          [data-dapp-body]{padding:16px 12px 64px !important;overflow-x:clip;}
          [data-dapp-grid]{grid-template-columns:1fr !important;gap:16px !important;}
          [data-slot="swap"]{order:1;}
          [data-slot="routes"]{order:2;}
          [data-slot="graph"]{order:3;}
          [data-site-footer]{padding:16px 12px 24px !important;}
          /* Install pill is long; on phones hide it so brand + wallet keep one row. */
          [data-header-install]{display:none !important;}
          [data-dapp-header-inner]{grid-template-columns:1fr auto !important;}
          /* desktop caps summary values at 60% width + nowrap; on a narrow
             card that clips the rate. Let them wrap to full width instead. */
          [data-sum-v]{max-width:100% !important;white-space:normal !important;}
          /* slippage control is the widest row; drop it below its label so the
             segmented pills never push the card past the viewport. */
          [data-slip-row]{flex-wrap:wrap;row-gap:8px;}
        }`}</style>
      <IconKeyframes />
      <div data-dapp-connect>
        <Header
          chains={chains}
          chain={chain}
          onChain={setChain}
          locked={chainLocked}
        />
      </div>

      <div style={d.body} data-dapp-body>
        <div style={d.grid} data-dapp-grid>
          {/* LEFT — graphical route; only shown once a venue/route exists. The
              slot is always reserved (mirrors the right slot) so the swap card
              stays centered whether or not the route panel is visible. */}
          <div style={d.sideSlot} data-slot="graph">
            {formMode === "swap" && (routeGraph || routeLoading || effectiveIsIntent) ? (
              <RouteGraph data={routeGraph} loading={routeLoading} intent={effectiveIsIntent} />
            ) : null}
          </div>

          {/* CENTER — editable swap card (page-centered, fixed width) */}
          <div style={d.swapSlot} data-slot="swap">
            <SwapForm
              chain={chain}
              tokenIn={tokenIn}
              tokenOut={tokenOut}
              onPickIn={() => setPickSide("in")}
              onPickOut={() => setPickSide("out")}
              onFlip={onFlip}
              amount={amount}
              onAmount={setAmount}
              editSide={editSide}
              onEditSide={setEditSide}
              balances={balances}
              quote={quote}
              quoteLoading={quoteLoading}
              quoteError={quoteError}
              mode={formMode}
              synthAmountOut={synthAmountOut}
              selectedVenue={effectiveVenue}
              slippageBps={slippageBps}
              onSlippageBps={setSlippageBps}
              venues={venues}
              enabledVenues={enabledVenues}
              onToggleVenue={onToggleVenue}
              onSetAllVenues={onSetAllVenues}
              allowAsync={allowAsync}
              cliJson={cliJson}
              onCliJson={onCliJson}
              cliData={cliData}
              onCliData={onCliData}
              cliSimu={cliSimu}
              onCliSimu={onCliSimu}
              isSend={isSend}
              onIsSend={setIsSend}
              recipient={recipient}
              onRecipient={setRecipient}
              connected={connected}
              senderAddress={address ?? null}
              onConnect={openConnect}
              onAction={onAction}
              actionBusy={actionBusy}
              actionLabel={actionLabel}
              actionDone={actionDone}
              actionHref={actionHref}
            />

            {/* execution panel — appears below the form once built */}
            {exec.phase === "error" && (
              <div style={d.execErr}>
                <Icon name="alert" size={15} style={{ color: "var(--negative)" }} />
                <span>Build failed — {exec.message}</span>
              </div>
            )}
            {exec.phase === "ready" && (
              <div style={d.execPanel}>
                <ExecutionLeg
                  sid={sid}
                  payload={exec.payload}
                  address={address}
                  onReset={resetForNewSwap}
                  onPhase={setExecRun}
                />
              </div>
            )}
          </div>

          {/* RIGHT — ranked routes */}
          <div style={d.sideSlot} data-slot="routes">
            <RoutesPane
              quote={quote}
              selectedVenue={effectiveVenue}
              onSelect={(v) => {
                if (quotesHeld) return;
                setSelectedVenue(v);
              }}
              action={noRouteNote}
              onRefresh={refresh}
              refreshLocked={refreshLocked}
              streaming={quoteStreaming}
              secondsToExpiry={secondsToExpiry}
              allowAsync={allowAsync}
              onAllowAsync={(allow) => {
                if (quotesHeld) return;
                setAllowAsync(allow);
              }}
            />
          </div>
        </div>
      </div>

      {/* token selector modal */}
      <TokenSelector
        chain={chain}
        value={pickSide === "in" ? tokenIn : tokenOut}
        onSelect={onSelectToken}
        onClose={() => setPickSide(null)}
        open={pickSide !== null}
        balances={balances}
      />

      <SiteFooter />

      {/* Discreet floating feedback widget → Google Form (no backend). */}
      <FeedbackWidget />
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Execution leg — renders the correct EXISTING component for the built Payload.
 * The Payload's chain/tokenIn/tokenOut/etc. are the wire shapes those
 * components already consume, so they're passed straight through. A small
 * footer offers "new swap" once done (the component itself reports to /done).
 * ------------------------------------------------------------------------ */
function ExecutionLeg({
  sid,
  payload,
  address,
  onReset,
  onPhase,
}: {
  sid: string;
  payload: Payload;
  address: string | undefined;
  onReset: () => void;
  onPhase?: (run: SendTxRun) => void;
}) {
  // Calldata / typedData / the order is hard-bound to payload.sender
  // (swap recipient, Permit2 owner, order signer). Signing from another
  // connected wallet would pull that wallet's funds while paying the
  // original sender. Hard-block all three legs, including retry.
  const senderLc = payload.sender.toLowerCase();
  const connectedLc = address?.toLowerCase() ?? null;
  const walletMismatch = connectedLc !== null && connectedLc !== senderLc;

  return (
    <div>
      <div style={d.execHead}>
        <span style={d.execTitle}>
          {payload.kind === "order" ? "Order" : "Transaction"}
        </span>
        <button type="button" onClick={onReset} style={d.newSwapBtn}>
          new swap
        </button>
      </div>

      {walletMismatch && (
        <div style={d.execMismatch}>
          <div style={d.execMismatchTitle}>
            <Icon name="alert" size={15} style={{ color: "var(--negative)" }} />
            wrong wallet
          </div>
          <div>
            Connected: <code>{address}</code>
          </div>
          <div>
            Expected: <code>{payload.sender}</code>
          </div>
          <div>
            Switch your wallet to the expected address. The swap is
            hard-bound to it (recipient address in the calldata / swapper
            in the Permit2 message), so signing or sending from a
            different wallet would either revert or pull funds from the
            connected wallet while sending output to the original sender.
          </div>
        </div>
      )}

      {/* Auto-fired + compact: clicking Swap opens the wallet directly — no
          duplicate confirmation panel. The trade details already live in the
          SwapForm card to the left. */}
      {!walletMismatch && payload.kind === "tx" && payload.tx && (
        <SendTx
          sid={sid}
          venue={payload.venue}
          tx={payload.tx}
          chain={payload.chain}
          tokenIn={payload.tokenIn}
          tokenOut={payload.tokenOut}
          amountIn={payload.amountIn}
          amountOut={payload.amountOut}
          recipient={payload.recipient}
          slippageBps={payload.slippageBps}
          approval={payload.approval}
          simulateEnabled={payload.simulateEnabled}
          autoStart
          compact
          onPhase={onPhase}
        />
      )}
      {!walletMismatch && payload.kind === "order" && payload.order && (
        <SignOrder
          sid={sid}
          order={payload.order}
          chain={payload.chain}
          tokenIn={payload.tokenIn}
          tokenOut={payload.tokenOut}
          amountIn={payload.amountIn}
          amountOut={payload.amountOut}
          minAmountOut={payload.minAmountOut}
          slippageBps={payload.slippageBps}
          approval={payload.approval}
          autoStart
          compact
          onPhase={onPhase}
        />
      )}
      {!walletMismatch && payload.kind === "permit-tx" && payload.permitTx && (
        <SignPermitTx
          sid={sid}
          permitTx={payload.permitTx}
          chain={payload.chain}
          tokenIn={payload.tokenIn}
          tokenOut={payload.tokenOut}
          amountIn={payload.amountIn}
          amountOut={payload.amountOut}
          slippageBps={payload.slippageBps}
          approval={payload.approval}
          assembleContext={payload.assembleContext}
          autoStart
          compact
          onPhase={onPhase}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * No-routing note (wrap / unwrap / send) — the right-pane content for modes
 * that bypass the aggregator. Mirrors the prototype's RoutesPane no-route note.
 * ------------------------------------------------------------------------ */
function NoRouteNote({
  mode,
  venueLabel,
}: {
  mode: "wrap" | "unwrap" | "send";
  venueLabel: string;
}) {
  const isWrap = mode === "wrap" || mode === "unwrap";
  const tint = vmeta(isWrap ? "wrap" : "send").tint;
  return (
    <div style={d.noRoute}>
      <span style={{ ...d.noRouteMark, background: tint }}>
        <Icon name={isWrap ? "swap" : "wallet"} size={16} style={{ color: "#fff" }} />
      </span>
      <div>
        <div style={{ fontWeight: 700, color: "var(--text-strong)", fontSize: 14 }}>
          {venueLabel}
        </div>
        <div style={{ color: "var(--text-tertiary)", fontSize: 12, marginTop: 2 }}>
          {isWrap
            ? "Native ↔ wrapped is 1:1 — no aggregator, a direct WETH9 call."
            : "Direct token transfer — no DEX routing."}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- styles ---------------------------------- */
const d: Record<string, React.CSSProperties> = {
  app: {
    minHeight: "100vh",
    background: "var(--surface-page)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "var(--font-sans)",
    position: "relative",
  },
  body: {
    // Full-width (stretches in the app's flex column); the inner content is
    // centered via maxWidth + margin:auto on `intro`/`grid`. (A maxWidth +
    // margin:auto here would shrink-to-fit the flex item and collapse the grid.)
    flex: 1,
    width: "100%",
    // 24px bottom so header + idle swap card + footer fit a 14" MacBook Pro
    // fullscreen viewport (~833px). Ranked venues can still grow the page.
    padding: "36px 40px 24px",
    boxSizing: "border-box",
    // Keep a stable scrollbar lane so quote height changes (slider re-quotes)
    // never show/hide the vertical bar and shove every column sideways.
    scrollbarGutter: "stable",
  },
  grid: {
    // Route graph (left) · swap card (center) · ranked routes (right). The fixed
    // center column + equal 1fr side columns keep the swap card page-centered and
    // unmoved whether or not the left route slot is filled. (Grid — not flex — so
    // it stretches to the body width instead of shrink-to-fitting.)
    display: "grid",
    width: "100%",
    gridTemplateColumns: "minmax(0, 1fr) 460px minmax(0, 1fr)",
    gap: 24,
    alignItems: "start",
    maxWidth: 1340,
    margin: "0 auto",
  },
  // minWidth:0 + overflow:hidden: side content (sankey SVG, long amounts) must
  // NEVER expand the 1fr tracks mid-stream — that was the horizontal thrash
  // when the slider re-quoted and route panels re-rendered.
  sideSlot: {
    minWidth: 0,
    maxWidth: "100%",
    width: "100%",
    overflow: "hidden",
    alignSelf: "start",
  },
  swapSlot: { minWidth: 0, width: "100%", alignSelf: "start" },

  execPanel: {
    marginTop: 16,
    background: "var(--surface-raised)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    padding: 18,
  },
  execHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  execTitle: {
    fontFamily: "var(--font-display)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text-strong)",
  },
  newSwapBtn: {
    border: "1px solid var(--border-default)",
    background: "var(--surface-frost)",
    color: "var(--text-secondary)",
    borderRadius: "var(--radius-pill)",
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  execErr: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 16,
    padding: "12px 14px",
    background: "var(--negative-bg)",
    border: "1px solid rgba(255,92,108,0.4)",
    borderRadius: "var(--radius-lg)",
    fontSize: 13,
    color: "var(--text-secondary)",
    overflowWrap: "anywhere",
  },
  execMismatch: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "12px 14px",
    background: "var(--negative-bg)",
    border: "1px solid rgba(255,92,108,0.4)",
    borderRadius: "var(--radius-lg)",
    fontSize: 13,
    color: "var(--text-secondary)",
    overflowWrap: "anywhere",
  },
  execMismatchTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    fontWeight: 700,
    color: "var(--negative)",
    margin: 0,
  },

  noRoute: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "14px",
    background: "var(--surface-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
  },
  noRouteMark: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  },
};

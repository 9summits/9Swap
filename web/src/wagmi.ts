import { useEffect, useRef } from "react";
import type { Chain, EIP1193Provider, PublicClient, Transport } from "viem";
import { createPublicClient, custom, defineChain, fallback } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  hyperEvm,
  ink,
  mainnet,
  monad,
  optimism,
  plasma,
  polygon,
  unichain,
} from "viem/chains";
import {
  http,
  createConfig,
  createConnector,
  useConnections,
  useDisconnect,
} from "wagmi";
import { safe } from "wagmi/connectors";
import {
  connectorsForWallets,
} from "@rainbow-me/rainbowkit";
import type { Wallet, WalletDetailsParams } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  rabbyWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import type { ChainMeta } from "./payload";
import { CORS_OPEN_RPC } from "./publicRpc";

// Robinhood Chain (id 4663) — not shipped in viem/chains, so define it
// locally. The public RPC is CORS-open (access-control-allow-origin: *),
// so the dApp's client-side balance reads work from the browser without
// a wallet. Only the `uniswap` venue quotes this chain server-side.
const robinhood = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

// Arc (id 5042) — viem 2.55 ships only `arcTestnet`, so define mainnet
// locally. The gas token is USDC and, at the EVM level (msg.value, balances,
// gas), it carries 18 decimals — the 6-decimal view is the ERC20 interface at
// 0x3600…0000, which is what the token list and calldata use.
const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

// Build a wagmi config matching the chain the CLI handed us. RainbowKit's
// own helpers want a list, so we include the major chains and use the
// payload's chainId to scope the page; the user can switch network in
// the wallet but the "Send" button is gated on chain match.
//
// Note on projectId: RainbowKit v2's `connectorsForWallets` requires a
// non-empty `projectId` string even if WalletConnect itself isn't used.
// When the CLI doesn't surface a real one (no WALLETCONNECT_PROJECT_ID),
// we substitute a placeholder so the helper doesn't throw. The
// WalletConnect wallet itself is excluded in that branch so the user
// sees only injected options.
const PLACEHOLDER_PROJECT_ID = "00000000000000000000000000000000";

// Exported so the dApp can build per-chain public clients (client-side
// balance reads) for chains the wallet isn't currently on.
export const knownChains: readonly [Chain, ...Chain[]] = [
  mainnet,
  base,
  robinhood,
  arc,
  hyperEvm,
  ink,
  arbitrum,
  optimism,
  avalanche,
  bsc,
  unichain,
  monad,
  plasma,
  polygon,
  gnosis,
];

// Public client for ad-hoc reads (dApp balance lookups) outside wagmi's hook
// surface. When the caller passes the CONNECTED wallet's EIP-1193 provider
// (wagmi `connector.getProvider()`, only when that wallet sits on the
// requested chain), reads ride the user's RPC quota; otherwise the chain's
// default public RPC. Never reach for `window.ethereum` here: with several
// wallet extensions installed that global is whichever registered last —
// possibly a different wallet parked on a different chain, whose answers
// (silently wrong chain, balanceOf "0x") broke the balance/MAX display.
export function publicClientFor(
  chainId: number,
  walletProvider?: EIP1193Provider,
): PublicClient | null {
  const chain = knownChains.find((c) => c.id === chainId);
  if (!chain) return null;
  const corsUrl = CORS_OPEN_RPC[chainId];
  const transports: Transport[] = [
    ...(walletProvider ? [custom(walletProvider, { retryCount: 0 })] : []),
    ...(corsUrl ? [http(corsUrl)] : []),
    http(),
  ];
  const transport =
    transports.length > 1 ? fallback(transports) : transports[0]!;
  return createPublicClient({ chain, transport });
}

// RainbowKit's stock safeWallet() builds the connector with safe()'s defaults,
// whose `unstable_getInfoTimeout` is 10 ms — too short for the first
// sdk.safe.getInfo() round trip through the app.safe.global frame on load, so
// the connector reports "not a Safe App" and the dApp starts disconnected.
// Everything else is inherited: safe()'s getProvider() self-gates on
// window.parent !== window, so this entry never surfaces outside a Safe iframe.
const safeAppWallet = (): Wallet => ({
  ...safeWallet(),
  createConnector: (details: WalletDetailsParams) =>
    createConnector((config) => ({
      ...safe({
        allowedDomains: [/^https:\/\/app\.safe\.global$/],
        unstable_getInfoTimeout: 3000,
      })(config),
      ...details,
    })),
});

export function buildWagmiConfig(args: {
  chain: ChainMeta;
  walletConnectProjectId: string | null;
}) {
  const realProjectId = args.walletConnectProjectId ?? null;
  const projectId = realProjectId ?? PLACEHOLDER_PROJECT_ID;
  const wcWallets = realProjectId ? [walletConnectWallet] : [];

  // No metaMaskWallet: it instantiates the MetaMask SDK connector, whose
  // provider is a fresh wrapper around the extension's — NOT the same object
  // instance. wagmi's reconnect() restores every authorized connector and
  // dedupes by provider instance, so on each page reload the SDK connector
  // slipped through and a second "shadow" connection formed. Disconnect then
  // appeared dead: wagmi only drops the current connection and promotes the
  // shadow, so the UI stayed connected no matter how many times the user
  // clicked. MetaMask users lose nothing — RainbowKit lists every installed
  // EIP-6963 wallet (MetaMask included) in the modal's "Installed" group,
  // and those connectors share the extension's provider instance, which the
  // reconnect dedup handles correctly. rabbyWallet stays: getInjectedConnector
  // targets the extension's own injected provider, same dedup story.
  //
  // Framed means inside app.safe.global (the CSP frame-ancestors allowlist
  // admits no other host), so the Safe connector is the only wallet that can
  // work there. Listing the others is not just noise: wagmi's reconnect()
  // walks every connector in series and useAccount() exposes no address until
  // the loop ends, and WalletConnect init plus the extensions' EIP-6963 probes
  // inside a cross-origin iframe took ~40 s, during which the dApp sat on
  // "Connect Wallet" with the Safe already authorized.
  const framed = typeof window !== "undefined" && window.parent !== window;
  const wallets = framed
    ? [safeAppWallet]
    : [injectedWallet, rabbyWallet, ...wcWallets];
  const connectors = connectorsForWallets(
    [
      {
        groupName: "Recommended",
        wallets,
      },
    ],
    {
      appName: "swap CLI",
      projectId,
    },
  );

  // Transports prefer a CORS-open public RPC, then fall back to viem's
  // chain default. Several viem defaults (mainnet's eth.merkle.io) reject
  // browser-origin requests, which made receipt polling hang forever.
  //
  // They used to prefer `window.ethereum` (piggybacking the visitor's own
  // wallet RPC quota instead of shared public endpoints), but that global is
  // whichever extension registered last — not necessarily the wallet the user
  // connected with, and possibly one this origin was never authorized for.
  // Background reads (block watcher, balance, receipt polling) then made that
  // extension pop an unsolicited connect prompt, with nothing clicked.
  //
  // Writes are unaffected: they always go through the wagmi connector's own
  // provider. Reads that should use the connected wallet's RPC go through
  // publicClientFor(chainId, connector.getProvider()) — an already-authorized
  // provider, so no prompt.
  //
  // We deliberately do NOT accept the CLI's RPC URL — keeping the
  // operator's Alchemy key out of the page closes the H3 audit
  // finding (the URL would otherwise be reachable from any extension
  // / lib in the React bundle / dev tools network tab).
  //
  // Note: when the wallet broadcasts via a MEV-protected RPC, inclusion is
  // still detected here once the tx lands on-chain (public nodes see the
  // mined receipt). useTxReceipt adds an independent poll as a second path.
  function transportFor(chainId: number): Transport {
    const cors = CORS_OPEN_RPC[chainId];
    return cors ? fallback([http(cors), http()]) : http();
  }

  return createConfig({
    // ssr:true even though this is a pure CSR app — it's the documented fix for
    // "wallet won't reconnect after a page reload". With ssr:false, wagmi's
    // onMount calls reconnect() synchronously during the first render, BEFORE
    // MIPD has injected the EIP-6963 connectors it discovered asynchronously
    // (real extensions announce their provider a tick late). reconnect() then
    // can't find the recentConnectorId connector and gives up WITHOUT ever
    // querying the wallet, so the user lands disconnected on every Cmd+R. ssr:true
    // makes onMount await persist.rehydrate() and re-sync the MIPD connectors
    // into config.connectors first, then reconnect — so the 6963 connector is
    // present and reconnect succeeds. No SSR markup exists, so there's no
    // hydration mismatch to worry about.
    ssr: true,
    chains: knownChains,
    connectors,
    // Same reason as the framed wallet list: EIP-6963 connectors would be
    // appended and walked by reconnect() before the Safe shows as connected.
    multiInjectedProviderDiscovery: !framed,
    transports: {
      [mainnet.id]: transportFor(mainnet.id),
      [arbitrum.id]: transportFor(arbitrum.id),
      [base.id]: transportFor(base.id),
      [optimism.id]: transportFor(optimism.id),
      [bsc.id]: transportFor(bsc.id),
      [unichain.id]: transportFor(unichain.id),
      [avalanche.id]: transportFor(avalanche.id),
      [hyperEvm.id]: transportFor(hyperEvm.id),
      [plasma.id]: transportFor(plasma.id),
      [polygon.id]: transportFor(polygon.id),
      [gnosis.id]: transportFor(gnosis.id),
      [ink.id]: transportFor(ink.id),
      [robinhood.id]: transportFor(robinhood.id),
      [arc.id]: transportFor(arc.id),
      [monad.id]: transportFor(monad.id),
    },
  });
}

// wagmi holds a MAP of connections and its disconnect() only drops the
// current one — when another connection to the same wallet exists (two
// connectors wrapping one extension, restored together by reconnect() on
// page load), wagmi "switches over" to it and the user stays connected no
// matter how many times they hit Disconnect (RainbowKit's account AND chain
// modals both call the single-connection disconnect). This dApp never
// intentionally multi-connects, so a connection that vanishes while a
// sibling to the SAME address survives can only be that promotion dance:
// finish the user's disconnect by dropping the survivors too. Mount once
// per WagmiProvider tree.
export function useDisconnectCompletion() {
  const connections = useConnections();
  const { disconnect } = useDisconnect();
  const prev = useRef(connections);
  useEffect(() => {
    const before = prev.current;
    prev.current = connections;
    if (connections.length === 0 || connections.length >= before.length) return;
    const remaining = new Set(connections.map((c) => c.connector.uid));
    const droppedAddrs = new Set(
      before
        .filter((b) => !remaining.has(b.connector.uid))
        .flatMap((b) => b.accounts.map((a) => a.toLowerCase())),
    );
    for (const c of connections) {
      if (c.accounts.some((a) => droppedAddrs.has(a.toLowerCase()))) {
        disconnect({ connector: c.connector });
      }
    }
  }, [connections, disconnect]);
}

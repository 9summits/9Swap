import { useEffect, useMemo, useState } from "react";
import { ConnectButton, RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAccount, WagmiProvider } from "wagmi";
import "@rainbow-me/rainbowkit/styles.css";
import "./ds/styles.css";
import type { Payload } from "./payload";
import { fetchPayload, sessionId } from "./api";
import { getMode } from "./dapp/api";
import type { ApiMode } from "./dapp/types";
import { InteractiveDapp } from "./dapp/InteractiveDapp";
import { buildWagmiConfig, useDisconnectCompletion } from "./wagmi";
import { SendTx } from "./SendTx";
import { SignOrder } from "./SignOrder";
import { SignPermitTx } from "./SignPermitTx";

const queryClient = new QueryClient();

// Two modes share one bundle:
//   - interactive (GET /api/mode → { interactive:true }) → the full dApp
//   - legacy sign-only (--browser): GET /tx → a pre-built Payload → SendTx/…
//
// App.tsx probes /api/mode first. If it resolves with interactive:true we mount
// <InteractiveDapp>; otherwise (endpoint missing / non-interactive) we fall
// back to the existing sign-only flow, preserved verbatim below.
type RouteState =
  | { phase: "probing" }
  | { phase: "interactive"; mode: ApiMode }
  | { phase: "legacy" }
  | { phase: "error"; message: string };

export function App() {
  const sid = useMemo(() => sessionId(), []);

  const [route, setRoute] = useState<RouteState>({ phase: "probing" });

  useEffect(() => {
    let cancelled = false;
    getMode(sid)
      .then((mode) => {
        if (cancelled) return;
        if (mode && mode.interactive) setRoute({ phase: "interactive", mode });
        else setRoute({ phase: "legacy" });
      })
      .catch((e) => {
        if (cancelled) return;
        // No ?id= and the server refused → the gate is on and the token is
        // missing; say so instead of falling through to the sign-only page.
        if (!sid) {
          setRoute({ phase: "error", message: "missing ?id=… in URL" });
          return;
        }
        // /api/mode absent or failed → this is a legacy --browser session.
        // Log so a real failure isn't silent, then fall through to sign-only.
        console.warn("/api/mode unavailable, using sign-only flow:", e);
        setRoute({ phase: "legacy" });
      });
    return () => {
      cancelled = true;
    };
  }, [sid]);

  if (route.phase === "error") {
    return (
      <div>
        <h1>swap — error</h1>
        <div className="err">{route.message}</div>
      </div>
    );
  }

  if (route.phase === "probing") {
    return (
      <div>
        <h1>swap</h1>
        <div className="muted">loading…</div>
      </div>
    );
  }

  if (route.phase === "interactive") {
    // Interactive dApp: the connected wallet is the sender (no --from). We use
    // a default chain from /api/mode for the initial wagmi config; the dApp's
    // chain selector switches network through the wallet at runtime.
    const defaultChain =
      route.mode.chains.find((c) => c.alias === route.mode.defaultChain) ??
      route.mode.chains[0];
    const config = buildWagmiConfig({
      chain: {
        chainId: defaultChain?.chainId ?? 1,
        name: defaultChain?.name ?? "Ethereum",
        explorer: defaultChain?.explorer ?? "https://etherscan.io",
        nativeSymbol: defaultChain?.nativeSymbol ?? "ETH",
      },
      walletConnectProjectId: route.mode.walletConnectProjectId,
    });
    return (
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider
            theme={darkTheme()}
            initialChain={defaultChain?.chainId ?? 1}
          >
            <InteractiveDapp mode={route.mode} sid={sid as string} />
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }

  // phase === "legacy"
  return <LegacySignOnly sid={sid as string} />;
}

// ----------------------------------------------------------------------------
// Legacy sign-only flow (--browser). Preserved verbatim from the original
// App.tsx: fetch a pre-built Payload (GET /tx) and route by payload.kind to
// SendTx / SignOrder / SignPermitTx with a wallet-match hard-gate.
// ----------------------------------------------------------------------------
function LegacySignOnly({ sid }: { sid: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPayload(sid)
      .then((p) => setPayload(p as Payload))
      .catch((e) => setError(e.message));
  }, [sid]);

  if (error) {
    return (
      <div>
        <h1>swap — error</h1>
        <div className="err">{error}</div>
      </div>
    );
  }
  if (!payload) {
    return (
      <div>
        <h1>swap</h1>
        <div className="muted">loading swap details…</div>
      </div>
    );
  }

  const config = buildWagmiConfig({
    chain: payload.chain,
    walletConnectProjectId: payload.walletConnectProjectId,
  });

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()} initialChain={payload.chain.chainId}>
          <Inner sid={sid} payload={payload} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Inner({ sid, payload }: { sid: string; payload: Payload }) {
  const { address } = useAccount();
  useDisconnectCompletion();

  // The tx / typedData / order is hard-bound to payload.sender (it's
  // the swap recipient in the calldata, the swapper in the Permit2
  // PermitSingle, etc.). If the user connects a different wallet:
  //   - tx kind: their wallet would sign+broadcast a tx that pulls
  //     their funds and sends the swap output to payload.sender (the
  //     --from address).
  //   - permit-tx: Permit2 recovers the SIGNER as the owner, so funds
  //     get pulled from the connected wallet but the signed message's
  //     spender/recipient still points at --from.
  //   - order: signer mismatch; relayer rejects.
  // All three are footguns. Hard-block actions when the connected
  // wallet isn't the one the CLI built for.
  const senderLc = payload.sender.toLowerCase();
  const connectedLc = address?.toLowerCase() ?? null;
  const walletMismatch = connectedLc !== null && connectedLc !== senderLc;

  return (
    <div>
      <h1>
        swap{" "}
        <span className="muted">
          via {payload.venue} on {payload.chain.name}
        </span>
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        from <code>{payload.sender}</code>
      </p>

      <div style={{ margin: "16px 0" }}>
        <ConnectButton />
      </div>

      {walletMismatch && (
        <div className="panel" style={{ borderColor: "#7a3030" }}>
          <h2 style={{ fontSize: 14, margin: "0 0 8px", color: "#ff8080" }}>
            ⚠ wrong wallet
          </h2>
          <div className="muted" style={{ marginBottom: 4 }}>
            Connected: <code>{address}</code>
          </div>
          <div className="muted" style={{ marginBottom: 12 }}>
            Expected (from CLI <code>--from</code>):{" "}
            <code>{payload.sender}</code>
          </div>
          <div className="err">
            Switch your wallet to the expected address. The swap is
            hard-bound to it (recipient address in the calldata / swapper
            in the Permit2 message), so signing or sending from a
            different wallet would either revert or pull funds from the
            connected wallet while sending output to the CLI sender.
          </div>
        </div>
      )}

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
        />
      )}
    </div>
  );
}

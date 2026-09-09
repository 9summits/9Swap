import { Component, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("swap web error:", error);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "32px 24px", maxWidth: 720, margin: "0 auto" }}>
          <h1>swap — render error</h1>
          <pre style={{ whiteSpace: "pre-wrap", color: "var(--red)" }}>
            {this.state.error.message}
          </pre>
          <p style={{ color: "var(--muted)" }}>
            Check the JS console for the full stack.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
(window as unknown as { __swapBooted: boolean }).__swapBooted = true;

import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Short git SHA baked into the bundle so the footer can show which dApp
// build is running. Prefer Vercel's commit env (set on every deploy), else
// `git rev-parse --short HEAD` for local / CLI-embed builds.
function appCommit(): string {
  const fromEnv =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    "";
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// Two build targets:
//   default  — single-file embed for the CLI binary (--browser / serve.ts):
//              every JS/CSS asset inlined into index.html, no external requests.
//   vercel   — standard Vite output with separate asset chunks for Vercel hosting:
//              index.html references /assets/* files, enabling CDN caching.
export default defineConfig(({ mode }) => {
  const isVercel = mode === "vercel";
  const commit = appCommit();
  return {
    plugins: isVercel ? [react()] : [react(), viteSingleFile()],
    // Available as the global `__APP_COMMIT__` (see src/vite-env.d.ts).
    define: {
      __APP_COMMIT__: JSON.stringify(commit),
    },
    server: {
      fs: { allow: [".."] },
    },
    build: {
      target: "es2020",
      chunkSizeWarningLimit: 4096,
      ...(isVercel
        ? { outDir: "dist-vercel" }
        : {
            cssCodeSplit: false,
            assetsInlineLimit: Infinity,
            // EMBED build only: mark @curvefi/api external. The CLI binary
            // inlines every dynamic import into one HTML file, so without
            // this the binary would balloon by several MB for a module the
            // local mode NEVER executes (curve runs server-side there; the
            // client-curve path only activates when the server doesn't offer
            // curve, which the local server always does). If that path ever
            // did run here, the dynamic import() fails cleanly and the venue
            // just stays absent. In vercel mode we DON'T set external, so
            // Vite emits a normal lazy chunk.
            rollupOptions: { external: ["@curvefi/api"] },
          }),
    },
  };
});

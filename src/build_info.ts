// Build provenance, baked in at compile time. Committed with both fields
// null: ./build and ./build-all overwrite this file with the real commit
// sha + UTC date (via scripts/build-info.ts) immediately before
// `bun build --compile`, then restore this stub — the same backup / trap /
// restore dance used for src/env.embedded.ts, so the working tree stays
// clean whether the build succeeds or fails.
//
// In a dev run (`bun run src/index.ts`) both fields stay null and
// src/version.ts falls back to asking git directly.
export const BUILD_INFO: { sha: string | null; date: string | null } = { sha: null, date: null };

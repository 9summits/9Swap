// Compile-time embed: ./build produces web/dist/index.html immediately before
// `bun build --compile`. Bun treats the text import as an asset and inlines it
// into the binary.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Bun's `with { type: "text" }` import returns a string at
// runtime, but the bundled type definitions describe HTMLBundle. The cast
// below normalizes the value for downstream consumers.
import INDEX_HTML from "../web/dist/index.html" with { type: "text" };
export const EMBEDDED_INDEX_HTML: string = INDEX_HTML as unknown as string;

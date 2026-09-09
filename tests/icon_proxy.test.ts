import { expect, test } from "bun:test";
import { ICON_CACHE_CONTROL, ICON_CDN_CACHE_CONTROL } from "../src/server/handlers.ts";

test("icon responses advertise a long browser + CDN cache", () => {
  expect(ICON_CACHE_CONTROL).toBe("public, max-age=604800, immutable");
  expect(ICON_CDN_CACHE_CONTROL).toContain("max-age=2592000");
  expect(ICON_CDN_CACHE_CONTROL).toContain("stale-while-revalidate=86400");
});

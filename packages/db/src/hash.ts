import { canonicalJson } from "@alfred/contracts";
import { createHash } from "node:crypto";

/**
 * SHA-256 over a canonical JSON pre-image, prefixed `sha256:`.
 *
 * Node-only (`node:crypto`), which is why it lives here and not in
 * `@alfred/contracts`. `canonicalJson` (browser-safe, key-sorted) supplies the
 * deterministic pre-image, so two processes digest the same value identically —
 * the property both the MCP catalog revision and the workflow revision content
 * hash depend on. A hand-rolled `JSON.stringify` does not have it.
 */
export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

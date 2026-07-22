import { canonicalJson } from "@alfred/contracts";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

/**
 * SHA-256 over a canonical JSON pre-image, prefixed `sha256:` — the same shape
 * the raw client uses for its catalog revision hash (`client.ts`). Node-only
 * (`node:crypto`), which is why these live in `@alfred/api` and not in
 * `@alfred/contracts`. `canonicalJson` (browser-safe, key-sorted) supplies the
 * deterministic pre-image so the digest is stable across hosts/processes.
 */
export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/**
 * Per-tool descriptor hash. Binds an approval/downgrade to the EXACT reviewed
 * descriptor, so an unrelated tool changing (which bumps the whole catalog
 * revision) need not churn a downgrade of a different tool, and a change to THIS
 * tool's descriptor silently reverts its downgrade to the high floor.
 */
export function descriptorHash(tool: Tool): string {
  return sha256Canonical(tool);
}

/** `{ [remoteName]: descriptorHash }` for a whole catalog snapshot. */
export function computeDescriptorHashes(tools: readonly Tool[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const tool of tools) hashes[tool.name] = descriptorHash(tool);
  return hashes;
}

/**
 * The security-relevant ambiguity-barrier key: SHA-256 over the canonical
 * EFFECTIVE arguments of an MCP call. Deliberately NOT the generic FNV-1a
 * `proposedInputHash` (which stays the staging/rejection dedup key) — the
 * barrier needs a collision-resistant cryptographic digest (issue clarification
 * #6).
 */
export function canonicalArgsHash(args: unknown): string {
  return sha256Canonical(args);
}

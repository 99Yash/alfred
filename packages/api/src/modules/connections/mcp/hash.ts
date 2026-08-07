import type { Tool } from "@modelcontextprotocol/client";
import { sha256Canonical } from "../../../lib/hash";

/**
 * `sha256Canonical` is the shared digest (`lib/hash`); the MCP-specific hashes
 * below are its callers. Re-exported here so `client.ts` and the broker keep
 * one import for all four.
 */
export { sha256Canonical };

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

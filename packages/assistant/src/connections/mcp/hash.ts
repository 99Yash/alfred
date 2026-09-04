import type { Tool } from "@modelcontextprotocol/client";
import { sha256Canonical } from "@alfred/db/hash";

/**
 * `sha256Canonical` is the shared digest (`lib/hash`); the MCP-specific hashes
 * below are its callers. Re-exported here so `client.ts` and the broker keep
 * one import for all four.
 */
export { sha256Canonical };

/**
 * Stable UTF-16 code-unit order. This EQUALS the default `Array.prototype.sort`
 * order for strings and is a named truth so the client, publication, and every
 * persisted hash-key order agree. Do not replace it with `localeCompare`: that
 * order differs and would reorder every persisted catalog.
 */
export function compareMcpToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
  for (const tool of tools) {
    // Remote tool names are untrusted data. Defining an own data property makes
    // every admitted name, including `__proto__`, a key instead of invoking an
    // inherited Object.prototype setter. Keep the normal prototype because the
    // Drizzle insert encoder expects ordinary record values.
    Object.defineProperty(hashes, tool.name, {
      configurable: true,
      enumerable: true,
      value: descriptorHash(tool),
      writable: true,
    });
  }
  return hashes;
}

/**
 * `{ [remoteName]: readOnly }` for a whole catalog snapshot, true ONLY where the
 * descriptor asserted `annotations.readOnlyHint === true`.
 *
 * A tool that declared no annotation is `false`. An optional annotation that is
 * absent carries no claim, and the one reading that admits a write is treating
 * "said nothing" as "is a read" (ADR-0094 amendment).
 *
 * Persisted beside {@link computeDescriptorHashes} and for the same reason: the
 * `mcp.call` dispatch gate resolves ONE tool per call and must not scan a
 * catalog-sized descriptor array to learn whether that tool claims to be a read
 * (ADR-0096).
 */
export function computeReadOnlyHints(tools: readonly Tool[]): Record<string, boolean> {
  const hints: Record<string, boolean> = {};
  for (const tool of tools) {
    // Same untrusted-name defense as `computeDescriptorHashes`: define an own
    // data property so `__proto__` becomes a key instead of a prototype setter.
    Object.defineProperty(hints, tool.name, {
      configurable: true,
      enumerable: true,
      value: tool.annotations?.readOnlyHint === true,
      writable: true,
    });
  }
  return hints;
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

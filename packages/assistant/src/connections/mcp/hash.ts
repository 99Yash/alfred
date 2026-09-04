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

/**
 * The two by-name projections a published catalog revision carries beside its
 * raw descriptors: `{ [remoteName]: descriptorHash }` and
 * `{ [remoteName]: readOnly }`.
 *
 * ONE function over ONE input, because the two maps are two readings of the
 * same descriptor array and must not be able to disagree with it or with each
 * other. Publication DERIVES this (`assertCanonicalCatalogPublication` no
 * longer accepts either map as an argument), so a caller cannot hand the
 * database a hash map that omits a tool, or a read-only map that claims `true`
 * for a write tool the descriptors call a write. A third projection is a third
 * key here and no new field anywhere else.
 *
 * Both maps exist for the same reason: the `mcp.call` dispatch gate resolves
 * ONE tool per call and must not scan a catalog-sized JSON array to learn that
 * tool's descriptor hash (#541) or its read-only claim (ADR-0096).
 *
 * `readOnly` is `true` ONLY where the descriptor asserted
 * `annotations.readOnlyHint === true`. A tool that declared no annotation is
 * `false`: an optional annotation that is absent carries no claim, and the one
 * reading that admits a write is treating "said nothing" as "is a read"
 * (ADR-0094 amendment).
 */
export interface McpCatalogProjection {
  readonly descriptorHashes: Record<string, string>;
  readonly readOnlyHints: Record<string, boolean>;
}

export function projectCatalogRevision(tools: readonly Tool[]): McpCatalogProjection {
  const descriptorHashes: Record<string, string> = {};
  const readOnlyHints: Record<string, boolean> = {};
  for (const tool of tools) {
    defineRemoteNameKey(descriptorHashes, tool.name, descriptorHash(tool));
    defineRemoteNameKey(readOnlyHints, tool.name, tool.annotations?.readOnlyHint === true);
  }
  return { descriptorHashes, readOnlyHints };
}

/**
 * Set one untrusted remote tool name as an OWN data property.
 *
 * Remote tool names are untrusted data. Defining an own data property makes
 * every admitted name, including `__proto__`, a key instead of invoking an
 * inherited `Object.prototype` setter. Keep the normal prototype because the
 * Drizzle insert encoder expects ordinary record values.
 */
function defineRemoteNameKey<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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

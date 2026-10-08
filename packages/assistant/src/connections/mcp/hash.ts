import type { Tool } from "@modelcontextprotocol/client";
import { sha256Canonical } from "@alfred/db/hash";

/** Re-exported so MCP callers import every hash from one place. */
export { sha256Canonical };

/** UTF-16 code-unit order. Never use `localeCompare`: it would reorder every stored catalog. */
export function compareMcpToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Binds a downgrade to one exact descriptor. If the descriptor changes, the tool returns to the high floor. */
export function descriptorHash(tool: Tool): string {
  return sha256Canonical(tool);
}

/**
 * By-name maps derived from the descriptors, so `mcp.call` reads one tool without
 * scanning the catalog (ADR-0096). A missing `readOnlyHint` is `false`.
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
 * Define an own property, so a remote name like `__proto__` is a key and not a setter.
 * Keep the normal prototype; the Drizzle encoder expects plain records.
 */
function defineRemoteNameKey<T>(target: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Ambiguity-barrier key. SHA-256, not the FNV-1a `proposedInputHash`: the barrier needs collision resistance. */
export function canonicalArgsHash(args: unknown): string {
  return sha256Canonical(args);
}

import type { ObjectStateAdapter } from "./adapter";

/**
 * The MCP adapter deliberately proposes NO key from free text.
 *
 * A generic MCP connection has no trusted sender grammar. Its key is minted
 * only after the owner-approved read returns an object identity and that exact
 * identity matches the deterministic loop key derived from the notification.
 * The approved-health verifier passes that data-backed key directly to
 * `reconcileEvidence`; this empty adapter keeps the provider registry complete
 * without turning arbitrary message text into closure authority.
 */
export const mcpObjectStateAdapter: ObjectStateAdapter = {
  provider: "mcp",
  proposeKeys() {
    return [];
  },
};

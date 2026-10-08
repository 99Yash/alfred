import type { ObjectStateAdapter } from "./adapter";

/**
 * Proposes no key from text: a generic MCP connection has no trusted sender grammar. The
 * approved-health verifier passes its data-backed key to `reconcileEvidence` directly.
 */
export const mcpObjectStateAdapter: ObjectStateAdapter = {
  provider: "mcp",
  proposeKeys() {
    return [];
  },
};

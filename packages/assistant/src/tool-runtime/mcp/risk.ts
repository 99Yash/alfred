/**
 * Effective risk tier for `mcp.call` at the dispatch gate.
 * `mcp.call` defaults to `high`. A reviewed policy (ADR-0069) or a read-only
 * built-in resource (ADR-0096) can lower it. Any doubt keeps `high`.
 * Reads the persisted catalog in one joined query; runs on every call.
 */

import { isToolRiskTier, type ToolRiskTier } from "@alfred/contracts";
import {
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type ResolveMcpToolIdentityInput,
} from "./invocations";

/** The tier when no downgrade applies. */
export const MCP_CALL_RISK_FLOOR: ToolRiskTier = "high";

/**
 * Tier for a structural read-only downgrade (ADR-0096). `low` is already approval-free.
 * Not `no_risk`: the server, not Alfred, wrote the schema the model fills.
 */
export const MCP_READ_ONLY_STRUCTURAL_TIER: ToolRiskTier = "low";

/** Resolve the risk tier for one `mcp.call` against the current catalog. */
export async function resolveMcpCallRiskTier(
  input: ResolveMcpToolIdentityInput,
): Promise<ToolRiskTier> {
  return effectiveMcpRiskTier(await resolveMcpToolIdentity(input));
}

/**
 * The tier a resolved identity grants. Recovery reuses it so a successor cannot
 * carry a tier the gate would refuse. Precedence: reviewed policy, then drifted
 * review (floor), then structural read-only, then the floor.
 */
export function effectiveMcpRiskTier(identity: McpToolIdentityResolution): ToolRiskTier {
  if (identity.status !== "resolved") return MCP_CALL_RISK_FLOOR;

  // `riskTier` is unvalidated `text`. An unknown string must not waive approval.
  if (identity.policy !== undefined) {
    if (!isToolRiskTier(identity.policy.riskTier)) return MCP_CALL_RISK_FLOOR;

    if (identity.policy.riskTier === MCP_CALL_RISK_FLOOR) return MCP_CALL_RISK_FLOOR;

    // A review lowers only a tool that claims `readOnlyHint` (ADR-0069). No fall-through.
    if (!identity.readOnly) return MCP_CALL_RISK_FLOOR;

    return identity.policy.riskTier;
  }

  // Reviewed, then drifted. Do not let the structural branch undo a raised review.
  if (identity.reviewed) return MCP_CALL_RISK_FLOOR;

  // Both come from durable state: the built-in registry (ADR-0094) and the published descriptor.
  if (identity.readOnlyResource && identity.readOnly) return MCP_READ_ONLY_STRUCTURAL_TIER;

  return MCP_CALL_RISK_FLOOR;
}

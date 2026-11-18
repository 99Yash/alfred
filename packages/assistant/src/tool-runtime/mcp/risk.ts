/**
 * Effective risk tier for `mcp.call` at the dispatch gate.
 * `mcp.call` defaults to `high`. A reviewed policy (ADR-0069), a code-owned built-in entry, or
 * a read-only built-in resource (ADR-0096) can lower it. Any doubt keeps `high`.
 * Reads the persisted catalog in one joined query; runs on every call.
 */

import { isToolRiskTier, type IntegrationSlug, type ToolRiskTier } from "@alfred/contracts";
import type { ReadFacts } from "../read-route";
import {
  mcpReadFacts,
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

/** What search needs to quote the route of one connected hit (ADR-0124 amendment 2026-11-18). */
export interface McpCallRouteFacts {
  riskTier: ToolRiskTier;
  facts: ReadFacts;
  /** The rule that governs the call: a built-in's provider, else `mcp`. */
  policyIntegration: IntegrationSlug;
}

/**
 * The tier, the read facts, and the policy rule of one selected tool, from one identity read.
 * So the three cannot come from different catalog or policy states, and search makes no
 * second query for the connection.
 */
export async function resolveMcpCallRouteFacts(
  input: ResolveMcpToolIdentityInput,
): Promise<McpCallRouteFacts> {
  const identity = await resolveMcpToolIdentity(input);

  return {
    riskTier: effectiveMcpRiskTier(identity),
    facts: mcpReadFacts(identity),
    policyIntegration: identity.status === "resolved" ? identity.policyIntegration : "mcp",
  };
}

/** The read facts of the current descriptor, for dispatch's route decision. */
export async function resolveMcpCallReadFacts(
  input: ResolveMcpToolIdentityInput,
): Promise<ReadFacts> {
  return mcpReadFacts(await resolveMcpToolIdentity(input));
}

/** Resolve the risk tier for one `mcp.call` against the current catalog. */
export async function resolveMcpCallRiskTier(
  input: ResolveMcpToolIdentityInput,
): Promise<ToolRiskTier> {
  return effectiveMcpRiskTier(await resolveMcpToolIdentity(input));
}

/**
 * The tier a resolved identity grants. Recovery reuses it so a successor cannot
 * carry a tier the gate would refuse. Precedence: reviewed policy, then drifted
 * review (floor), then the code-owned entry, then structural read-only, then the floor.
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

  // Code pins the exact descriptor (ADR-0096 amendment, 2026-11-13). Like a review, it lowers
  // only a tool that claims `readOnlyHint`: neither the pin nor the hint is enough alone.
  if (identity.codePolicy !== undefined) {
    return identity.readOnly ? identity.codePolicy.riskTier : MCP_CALL_RISK_FLOOR;
  }

  // Both come from durable state: the built-in registry (ADR-0094) and the published descriptor.
  if (identity.readOnlyResource && identity.readOnly) return MCP_READ_ONLY_STRUCTURAL_TIER;

  return MCP_CALL_RISK_FLOOR;
}

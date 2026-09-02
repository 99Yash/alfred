/**
 * Gate-side effective-risk resolution for `mcp.call` (#541 Part 3).
 *
 * `mcp.call` carries a STATIC `high` floor in its tool definition, so an
 * unreviewed MCP tool always stages for approval. This resolver is the reviewed
 * DOWNGRADE half: if the user has reviewed the EXACT descriptor the model
 * selected and recorded a lower tier in `mcp_tool_policy`, that reviewed tier
 * applies and a routine safe call (e.g. a read tool downgraded to `low`) stops
 * prompting every time.
 *
 * It runs at the DISPATCH GATE, before any live client is hydrated, so it reads
 * the PERSISTED catalog rather than the network. Every point of uncertainty
 * resolves to the conservative `high` floor:
 *   - the connection is missing or owned by another user;
 *   - the model echoed a `catalogRevision` that is not the connection's current
 *     one (a stale view — descriptor drift may have re-gated the tool, story #12);
 *   - the selected `remoteName` has no descriptor in that revision;
 *   - no reviewed policy exists for that exact descriptor hash (stories #10/#11:
 *     a downgrade binds to the descriptor it was granted for, so drift produces a
 *     fresh key, a miss, and a re-gate).
 *
 * The broker consumes the SAME `resolveMcpToolIdentity` derivation at execute
 * time, then requires its persisted descriptor hash to equal the live client's
 * hash before honoring the policy. The approval and effect axes therefore have
 * one durable identity owner, while live drift still falls back conservatively.
 *
 * NOTE (hot path): this runs on EVERY `mcp.call` dispatch. The connection,
 * current revision, descriptor hash, and policy are resolved in one joined read.
 */

import { isToolRiskTier, type ToolRiskTier } from "@alfred/contracts";
import {
  resolveMcpToolIdentity,
  type McpToolIdentityResolution,
  type ResolveMcpToolIdentityInput,
} from "./invocations";

/** The conservative floor an `mcp.call` falls back to when no reviewed downgrade applies. */
export const MCP_CALL_RISK_FLOOR: ToolRiskTier = "high";

/**
 * Resolve the effective risk tier for one `mcp.call`, applying a reviewed
 * per-descriptor downgrade when — and only when — it binds to the exact tool the
 * model is about to call on the connection's current catalog.
 */
export async function resolveMcpCallRiskTier(
  input: ResolveMcpToolIdentityInput,
): Promise<ToolRiskTier> {
  return effectiveMcpRiskTier(await resolveMcpToolIdentity(input));
}

/**
 * The reviewed tier an already-resolved identity grants, or the floor. The
 * recovery successor mint reuses this so its staging row cannot carry a tier the
 * dispatch gate would have refused.
 */
export function effectiveMcpRiskTier(identity: McpToolIdentityResolution): ToolRiskTier {
  if (identity.status !== "resolved") return MCP_CALL_RISK_FLOOR;

  // `policy.riskTier` is a `$type<ToolRiskTier>()` cast over persisted `text`, not
  // a validated value. Treat it as `unknown` (repo invariant): a corrupt or
  // out-of-enum tier must re-gate to the floor, never silently un-gate — only
  // `"high"` gates, so an unrecognized string would otherwise waive approval.
  return isToolRiskTier(identity.policy?.riskTier) ? identity.policy.riskTier : MCP_CALL_RISK_FLOOR;
}

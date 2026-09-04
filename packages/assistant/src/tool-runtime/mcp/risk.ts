/**
 * Gate-side effective-risk resolution for `mcp.call` (#541 Part 3).
 *
 * `mcp.call` carries a STATIC `high` floor in its tool definition, so an
 * unreviewed MCP tool always stages for approval. This resolver is the DOWNGRADE
 * half, and there are two authorities for one.
 *
 * The REVIEWED downgrade (#541): if the user has reviewed the EXACT descriptor
 * the model selected and recorded a tier in `mcp_tool_policy`, that tier
 * applies, and a routine safe call stops prompting every time.
 *
 * The STRUCTURAL downgrade (ADR-0096): a tool on a connection whose endpoint the
 * built-in registry marks as a read-only protected resource, and whose own
 * descriptor asserted `annotations.readOnlyHint`, is a read on two independent
 * proofs and needs no per-descriptor review. The reason it is not nagging-relief
 * dressed as safety is the comparison it makes honest — Alfred already grants
 * approval-free private-repository reads through the curated `github.*` tools,
 * so charging an approval for the SAME read over a different transport was an
 * accident of which door was built first, not a posture.
 *
 * It runs at the DISPATCH GATE, before any live client is hydrated, so it reads
 * the PERSISTED catalog rather than the network. Every point of uncertainty
 * resolves to the conservative `high` floor:
 *   - the connection is missing or owned by another user;
 *   - the model echoed a `catalogRevision` that is not the connection's current
 *     one (a stale view — descriptor drift may have re-gated the tool, story #12);
 *   - the selected `remoteName` has no descriptor in that revision;
 *   - the tool was reviewed under a descriptor that has since drifted (stories
 *     #10/#11: a downgrade binds to the descriptor it was granted for, so drift
 *     produces a fresh key, a miss, and a re-gate — and the structural branch
 *     below must not paper over that miss);
 *   - no reviewed policy exists at all AND the structural conditions do not both
 *     hold.
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
 * The tier a STRUCTURAL downgrade grants (ADR-0096). `low`, not `no_risk`.
 *
 * Only `high` gates, so `low` is already approval-free and matches what the
 * curated `github.*` reads cost the user. It stops short of `no_risk`, which
 * those curated reads carry, because the two are not the same claim: a curated
 * read is an Alfred-authored call with a fixed shape, while an MCP read runs a
 * server-authored schema against model-chosen arguments. The difference does
 * not change the gate; it changes what the tier honestly says.
 */
export const MCP_READ_ONLY_STRUCTURAL_TIER: ToolRiskTier = "low";

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
 * The tier an already-resolved identity grants, or the floor. The recovery
 * successor mint reuses this so its staging row cannot carry a tier the dispatch
 * gate would have refused.
 *
 * Four branches, in strict precedence:
 *
 * 1. **A reviewed policy row for THIS descriptor wins outright**, in both
 *    directions. It is the user's explicit decision about this exact
 *    descriptor, so it must be able to raise the tier as well as lower it. A
 *    row whose persisted tier is corrupt is an uncertainty, so it takes the
 *    floor and does NOT fall through: a present-but-unreadable review is not
 *    the same as no review at all.
 * 2. **A tool reviewed under a DIFFERENT descriptor takes the floor.** The user
 *    reviewed this tool and its descriptor has since drifted. Without this
 *    branch the drift would fall through to the structural downgrade, which
 *    would silently undo a review that RAISED the tier — the user asked to be
 *    prompted, and a server-side description edit would have cancelled the
 *    ask. Re-gating is what "a reviewed policy wins in both directions" has to
 *    mean under drift.
 * 3. **The structural downgrade (ADR-0096)** applies when the connection's
 *    endpoint is a built-in read-only protected resource AND the persisted
 *    catalog records this tool's own `readOnlyHint`. Two independent
 *    conditions, both read from durable state at the gate.
 * 4. **Otherwise the floor.**
 */
export function effectiveMcpRiskTier(identity: McpToolIdentityResolution): ToolRiskTier {
  if (identity.status !== "resolved") return MCP_CALL_RISK_FLOOR;

  // `policy.riskTier` is a `$type<ToolRiskTier>()` cast over persisted `text`, not
  // a validated value. Treat it as `unknown` (repo invariant): a corrupt or
  // out-of-enum tier must re-gate to the floor, never silently un-gate — only
  // `"high"` gates, so an unrecognized string would otherwise waive approval.
  if (identity.policy !== undefined) {
    return isToolRiskTier(identity.policy.riskTier)
      ? identity.policy.riskTier
      : MCP_CALL_RISK_FLOOR;
  }

  // Reviewed once, drifted since. The structural branch below re-proves that
  // the NEW descriptor is a read, which is true and is not the question: the
  // user's decision about this tool is what drifted out of reach, and only the
  // floor is faithful to it until they review the new descriptor.
  if (identity.reviewed) return MCP_CALL_RISK_FLOOR;

  // The structural authority. Neither half is a claim Alfred takes from the
  // model or from the call: `readOnlyResource` is pinned in Alfred's own
  // built-in registry (ADR-0094), and `readOnly` was projected from the
  // descriptor the catalog actually published. A user-added server satisfies
  // neither, so it keeps the floor until its descriptor is reviewed.
  if (identity.readOnlyResource && identity.readOnly) return MCP_READ_ONLY_STRUCTURAL_TIER;

  return MCP_CALL_RISK_FLOOR;
}

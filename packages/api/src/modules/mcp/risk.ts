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
 * The broker resolves policy on the SAME `(connection, remoteName, descriptorHash)`
 * key at execute time to drive the effect/ambiguity axis (`broker.ts`); this
 * function drives only the approval axis. They land on the same descriptor hash —
 * and thus the same reviewed row — ONLY when the catalog does not drift between
 * gate and execute: the gate reads `revision.descriptorHashes[remoteName]` off the
 * connection's current-at-gate revision, while the broker recomputes
 * `descriptorHash(liveTool)` from the live catalog. Under drift they diverge, and
 * both INDEPENDENTLY fall back to their conservative default (the `high` floor
 * here; `unknown`/effectful there). So the two axes are not guaranteed coherent —
 * they are guaranteed to each default conservatively on divergence.
 *
 * NOTE (hot path): this runs on EVERY `mcp.call` dispatch and does three serial
 * DB reads (connection → revision → policy), and the connection is read a second
 * time in the broker at execute. Acceptable for a heavyweight outbound MCP call,
 * but it is redundant work on the gate path — collapse into one read if the gate
 * ever needs to run cheaper.
 */

import { isToolRiskTier, type ToolRiskTier } from "@alfred/contracts";
import { readConnection, readRevisionById, readToolPolicy } from "./persistence";

/** The conservative floor an `mcp.call` falls back to when no reviewed downgrade applies. */
export const MCP_CALL_RISK_FLOOR: ToolRiskTier = "high";

export interface McpCallRiskInput {
  userId: string;
  connectionId: string;
  remoteName: string;
  /** The catalog revision hash the model selected the tool under (echoed on the call). */
  catalogRevision: string;
}

/**
 * Resolve the effective risk tier for one `mcp.call`, applying a reviewed
 * per-descriptor downgrade when — and only when — it binds to the exact tool the
 * model is about to call on the connection's current catalog.
 */
export async function resolveMcpCallRiskTier(input: McpCallRiskInput): Promise<ToolRiskTier> {
  const connection = await readConnection(input.connectionId);
  // Ownership is Alfred's trust boundary: never honor a downgrade for a
  // connection the caller does not own (the broker rejects it at execute too).
  if (!connection || connection.userId !== input.userId) return MCP_CALL_RISK_FLOOR;

  // Only the connection's CURRENT revision counts. If the model echoed a stale
  // revision, its view predates a possible catalog change, so re-gate at the floor.
  if (!connection.currentCatalogRevisionId) return MCP_CALL_RISK_FLOOR;
  const revision = await readRevisionById(connection.currentCatalogRevisionId);
  if (!revision || revision.revisionHash !== input.catalogRevision) {
    return MCP_CALL_RISK_FLOOR;
  }

  const descriptorHash = revision.descriptorHashes[input.remoteName];
  if (!descriptorHash) return MCP_CALL_RISK_FLOOR;

  const policy = await readToolPolicy(input.connectionId, input.remoteName, descriptorHash);
  // `policy.riskTier` is a `$type<ToolRiskTier>()` cast over persisted `text`, not
  // a validated value. Treat it as `unknown` (repo invariant): a corrupt or
  // out-of-enum tier must re-gate to the floor, never silently un-gate — only
  // `"high"` gates, so an unrecognized string would otherwise waive approval.
  return isToolRiskTier(policy?.riskTier) ? policy.riskTier : MCP_CALL_RISK_FLOOR;
}

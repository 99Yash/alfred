/**
 * Policy seeding and broker replacement for tests only, kept off the product door
 * (`@alfred/assistant/tool-runtime/mcp`) for the reason
 * `packages/assistant/src/action-policies/test-support.ts` states: a name only a
 * test wants should cost a subpath called `test-support`, not a place on the
 * interface production reads.
 *
 * `upsertToolPolicy` writes the reviewed-downgrade row that ADR-0088 makes the one
 * input able to lower an MCP call BELOW the risk floor. Nothing in `src` mints one
 * — the approval flow does, and it does not live here yet.
 *
 * `_setMcpExecutionBrokerForTests` drops the process-lifetime broker singleton.
 * Nothing in `src` replaces it, and the same rule already put its twin
 * `_setMcpConnectionManagerForTests` behind
 * `@alfred/assistant/connections/mcp/test-support`: the two singletons are
 * independent since the module split, so replacing either one from product code
 * would leave the other holding a stale view of the same connection.
 *
 * This module is behind an exact `exports` key, but note the door beside it is
 * tier 4, not tier 1: `"./tool-runtime/*"` already republishes every leaf under the
 * directory, so `invocations` itself resolves regardless. Campaign item 79 owns
 * narrowing that wildcard; until it lands this file is a convention, and after it
 * lands it becomes the fence it reads as.
 */

import { db } from "@alfred/db";
import { requireRow, type DbRunner } from "@alfred/db/helpers";
import {
  actionStagings,
  mcpInvocation,
  type McpInvocation,
  type NewMcpInvocation,
} from "@alfred/db/schemas";
import { eq } from "drizzle-orm";

export { upsertToolPolicy } from "./invocations";
export { _setMcpExecutionBrokerForTests } from "./runtime";

/** Seed an exact ledger state for persistence and crash-recovery tests only. */
export async function seedMcpInvocationForTests(
  values: NewMcpInvocation,
  runner: DbRunner = db(),
): Promise<McpInvocation> {
  const [staging] = await runner
    .select({
      traceId: actionStagings.runId,
      stepId: actionStagings.stepId,
      toolCallId: actionStagings.toolCallId,
    })
    .from(actionStagings)
    .where(eq(actionStagings.id, values.stagingId))
    .limit(1);
  const [row] = await runner
    .insert(mcpInvocation)
    .values({ ...values, ...requireRow(staging, "seedMcpInvocationForTests staging") })
    .returning();
  return requireRow(row, "seedMcpInvocationForTests");
}

/** Patch an exact ledger state for persistence fixtures only. */
export async function patchMcpInvocationForTests(
  id: string,
  patch: Partial<NewMcpInvocation>,
  runner: DbRunner = db(),
): Promise<McpInvocation | undefined> {
  const [row] = await runner
    .update(mcpInvocation)
    .set(patch)
    .where(eq(mcpInvocation.id, id))
    .returning();
  return row;
}

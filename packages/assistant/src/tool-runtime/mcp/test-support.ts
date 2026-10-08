/**
 * Test-only MCP helpers, kept off the product door like `action-policies/test-support.ts`.
 * `upsertToolPolicy` seeds an exact review row; production goes through `reviewMcpToolPolicy`.
 * `_setMcpExecutionBrokerForTests` replaces the broker singleton. Its twin
 * `_setMcpConnectionManagerForTests` is in `@alfred/assistant/connections/mcp/test-support`.
 */

import { db } from "@alfred/db";
import { requireRow, type DbRunner } from "@alfred/db/helpers";
import { isUniqueViolation, uniqueViolationConstraint } from "@alfred/db/pg-errors";
import {
  actionStagings,
  mcpInvocation,
  type McpInvocation,
  type NewMcpInvocation,
} from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";

export { upsertToolPolicy } from "./invocations";

export { _setMcpExecutionBrokerForTests } from "./runtime";

type TestInvocationReservation = Pick<
  NewMcpInvocation,
  | "userId"
  | "connectionId"
  | "remoteName"
  | "argsHash"
  | "catalogRevisionId"
  | "descriptorHash"
  | "policyRevision"
  | "effectClass"
> & { stagingId: string };

/**
 * Copy correlation from the staging row, then insert the ledger row.
 * Keep the chain shape: `persistence.test.ts` fakes it with a hand-built runner.
 */
async function insertMcpInvocationFixture(
  values: NewMcpInvocation & { stagingId: string },
  runner: DbRunner,
  label: string,
): Promise<McpInvocation> {
  const [staging] = await runner
    .select({
      traceId: actionStagings.runId,
      stepId: actionStagings.stepId,
      toolCallId: actionStagings.toolCallId,
    })
    .from(actionStagings)
    .where(and(eq(actionStagings.id, values.stagingId), eq(actionStagings.userId, values.userId)))
    .limit(1);

  const [row] = await runner
    .insert(mcpInvocation)
    .values({ ...values, ...requireRow(staging, `${label} staging`) })
    .returning();

  return requireRow(row, label);
}

/** A `prepared` mint whose unique violation is classified like the broker's. */
export async function reserveMcpInvocationForTests(
  values: TestInvocationReservation,
  runner: DbRunner = db(),
): Promise<
  { ok: true; invocation: McpInvocation } | { ok: false; reason: "barrier" | "duplicate_staging" }
> {
  try {
    const invocation = await insertMcpInvocationFixture(
      { ...values, attemptLifecycle: "prepared" },
      runner,
      "reserveMcpInvocationForTests",
    );

    return { ok: true, invocation };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    return uniqueViolationConstraint(error) === "mcp_invocation_staging_idx"
      ? { ok: false, reason: "duplicate_staging" }
      : { ok: false, reason: "barrier" };
  }
}

/** Seed an exact ledger state. */
export async function seedMcpInvocationForTests(
  values: NewMcpInvocation & { stagingId: string },
  runner: DbRunner = db(),
): Promise<McpInvocation> {
  return insertMcpInvocationFixture(values, runner, "seedMcpInvocationForTests");
}

/** Patch an exact ledger state. */
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

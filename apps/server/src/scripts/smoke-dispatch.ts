/**
 * Smoke test for m13 Phase 3 — the tool dispatcher.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-dispatch.ts
 *
 * Walks the Phase 3 acceptance bullets end-to-end against real Postgres
 * and Redis. The tools the dispatcher calls are stubs registered into
 * the in-process registry (not real Gmail) so the smoke doesn't need an
 * OAuth account — the full integrated run lives in Phase 9's
 * `smoke-boss.ts`.
 *
 * Bullets exercised:
 *   1. Autonomy path: gmail.search-shape stub → row executed → result returned.
 *      Unknown tool names return a recoverable tool result without staging.
 *   2. Gated path: gmail.send_draft-shape stub → row pending + HIL wake;
 *      approve via direct DB update + signalRun; re-dispatch same
 *      tool_call_id → row executed, no second tool execution.
 *   3. Retry suppression: reject a gated call; re-dispatch the same
 *      tool_name + input under a NEW tool_call_id → synthesized
 *      `rejected_by_user` result, no second row, no second notify path.
 *   4. cancelRun: idempotent transitions + pending approval cleanup.
 */

import {
  bustPolicyCache,
  cancelRun,
  clearToolRegistryForTests,
  closeConnections,
  closeRedis,
  dispatchToolCall,
  ensureDefaultActionPolicyForUser,
  liveTool,
  registerTools,
  signalRun,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  user as userTable,
  userActionPolicies,
} from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  assert,
  createSmokeRun,
  findOrCreateSmokeUser,
} from "./_smoke-helpers";

const SMOKE_USER_EMAIL = "smoke-dispatch@alfred.local";

async function setIntegrationMode(
  userId: string,
  slug: "gmail",
  mode: "autonomy" | "gated",
): Promise<void> {
  await db()
    .update(userActionPolicies)
    .set({
      integrationRules: { system: { mode: "autonomy" }, [slug]: { mode } },
    })
    .where(eq(userActionPolicies.userId, userId));
  bustPolicyCache(userId);
}

interface Stubs {
  readonly searchExecCount: () => number;
  readonly draftExecCount: () => number;
  registerStubs(): void;
}

function buildStubs(): Stubs {
  let searchExec = 0;
  let draftExec = 0;
  return {
    searchExecCount: () => searchExec,
    draftExecCount: () => draftExec,
    registerStubs() {
      const gmailSearchInput = z
        .object({
          q: z.string().min(1).max(500),
          maxResults: z.number().int().min(1).max(50).default(10),
        })
        .strict();
      const gmailSendDraftInput = z
        .object({
          to: z.array(z.string().email()).min(1).max(25),
          subject: z.string().min(1).max(1000),
          bodyText: z.string().min(1).max(50_000),
        })
        .strict();

      registerTools([
        liveTool({
          integration: "gmail",
          action: "search",
          riskTier: "no_risk",
          description: "Smoke-test Gmail search tool.",
          inputSchema: gmailSearchInput,
          execute: async (input) => {
            searchExec += 1;
            return {
              messages: [{ id: "smoke-m1", query: input.q }],
              nextPageToken: null,
            };
          },
        }),
        liveTool({
          integration: "gmail",
          action: "send_draft",
          riskTier: "high",
          description: "Smoke-test Gmail draft send tool.",
          inputSchema: gmailSendDraftInput,
          execute: async (input) => {
            draftExec += 1;
            return { sentTo: input.to[0], subject: input.subject };
          },
        }),
      ]);
    },
  };
}

async function main(): Promise<void> {
  await warmPool();
  clearToolRegistryForTests();
  const stubs = buildStubs();
  stubs.registerStubs();

  const userId = await findOrCreateSmokeUser("smoke-dispatch@alfred.local");
  await ensureDefaultActionPolicyForUser(userId);

  // ─── 1. Autonomy path ────────────────────────────────────────────────
  await setIntegrationMode(userId, "gmail", "autonomy");
  const runId1 = await createSmokeRun(userId, "autonomy-turn");
  const auto = await dispatchToolCall({
    runId: runId1,
    stepId: "turn-1",
    toolCallId: "tc_search_auto",
    toolName: "gmail.search",
    input: { q: "in:inbox newer_than:1d" },
    userId,
  });
  assert(
    auto.kind === "executed",
    `autonomy expected 'executed', got '${auto.kind}'`,
  );
  assert(
    stubs.searchExecCount() === 1,
    `tool.execute should fire exactly once, got ${stubs.searchExecCount()}`,
  );
  const autoRow = (
    await db()
      .select()
      .from(actionStagings)
      .where(eq(actionStagings.id, (auto as { stagingId: string }).stagingId))
  )[0];
  assert(autoRow, "autonomy staging row missing");
  assert(
    autoRow.status === "executed",
    `autonomy row expected 'executed', got '${autoRow.status}'`,
  );
  assert(
    autoRow.requiresApproval === false,
    "autonomy row should have requires_approval=false",
  );
  assert(
    autoRow.executeResult !== null,
    "autonomy row should carry execute_result",
  );
  console.log("[smoke-dispatch] 1. autonomy: row=executed, tool fired once ✓");

  // Idempotent re-dispatch with same tool_call_id returns the cached
  // result without firing the tool a second time.
  const auto2 = await dispatchToolCall({
    runId: runId1,
    stepId: "turn-1",
    toolCallId: "tc_search_auto",
    toolName: "gmail.search",
    input: { q: "in:inbox newer_than:1d" },
    userId,
  });
  assert(
    auto2.kind === "executed",
    "idempotent re-dispatch expected 'executed'",
  );
  assert(
    stubs.searchExecCount() === 1,
    `idempotent re-dispatch should not re-execute, got ${stubs.searchExecCount()}`,
  );
  console.log(
    "[smoke-dispatch] 1. autonomy: idempotent re-dispatch returns cached result ✓",
  );

  const unknownTool = await dispatchToolCall({
    runId: runId1,
    stepId: "turn-1",
    toolCallId: "tc_unknown_tool",
    toolName: "gmail.hallucinated_action",
    input: { q: "in:inbox" },
    userId,
  });
  assert(
    unknownTool.kind === "unknown_tool",
    `unknown tool expected 'unknown_tool', got '${unknownTool.kind}'`,
  );
  const unknownRows = await db()
    .select()
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.runId, runId1),
        eq(actionStagings.toolCallId, "tc_unknown_tool"),
      ),
    );
  assert(
    unknownRows.length === 0,
    "unknown tool should not write a staging row",
  );
  console.log("[smoke-dispatch] 1. unknown tool: recoverable result, no row ✓");

  // ─── 2. Gated path ───────────────────────────────────────────────────
  await setIntegrationMode(userId, "gmail", "gated");
  const runId2 = await createSmokeRun(userId, "gated-turn");
  const staged = await dispatchToolCall({
    runId: runId2,
    stepId: "turn-1",
    toolCallId: "tc_draft_gated",
    toolName: "gmail.send_draft",
    input: {
      to: ["yash@example.com"],
      subject: "phase 3 smoke",
      bodyText: "hi",
    },
    userId,
  });
  assert(
    staged.kind === "staged",
    `gated expected 'staged', got '${staged.kind}'`,
  );
  const stagedId = (staged as { stagingId: string }).stagingId;
  assert(
    (staged as { wake: { approvalId: string; approvalKind: string } }).wake
      .approvalId === stagedId,
    "wake.approvalId must equal stagingId",
  );
  assert(
    (staged as { wake: { approvalKind: string } }).wake.approvalKind ===
      "action_staging",
    "wake.approvalKind must be 'action_staging'",
  );
  assert(
    stubs.draftExecCount() === 0,
    "gated path must not execute tool before approval",
  );
  const gatedRow = (
    await db()
      .select()
      .from(actionStagings)
      .where(eq(actionStagings.id, stagedId))
  )[0];
  assert(
    gatedRow?.status === "pending",
    `gated row expected 'pending', got '${gatedRow?.status}'`,
  );
  assert(
    gatedRow.requiresApproval === true,
    "gated row should have requires_approval=true",
  );
  assert(
    gatedRow.riskTier === "high",
    "gated row should snapshot risk_tier='high'",
  );
  console.log("[smoke-dispatch] 2. gated: row=pending, wake=action_staging ✓");

  // Policy toggle should NOT unstick a pending row. Flip the user to
  // autonomy and re-dispatch the same tool_call_id — the row was staged
  // under the gated policy and must stay parked until the user explicitly
  // approves. Otherwise a settings toggle would silently auto-execute
  // every in-flight gated call.
  await setIntegrationMode(userId, "gmail", "autonomy");
  const stillStaged = await dispatchToolCall({
    runId: runId2,
    stepId: "turn-1",
    toolCallId: "tc_draft_gated",
    toolName: "gmail.send_draft",
    input: {
      to: ["yash@example.com"],
      subject: "phase 3 smoke",
      bodyText: "hi",
    },
    userId,
  });
  assert(
    stillStaged.kind === "staged",
    `pending row must remain staged after policy flip, got '${stillStaged.kind}'`,
  );
  assert(
    stubs.draftExecCount() === 0,
    "policy flip must not trigger execute on pending row",
  );
  console.log(
    "[smoke-dispatch] 2. gated: policy gated→autonomy keeps pending row staged ✓",
  );

  // Restore gated for the approval path below — the locked-in
  // requires_approval=true on the row is what matters now, not the
  // live policy.
  await setIntegrationMode(userId, "gmail", "gated");

  // Simulate the executor parking the run on this wake — the dispatcher
  // returned the wake but didn't write it; the agent loop (Phase 4)
  // bubbles it up to a StepResult.interrupt which the executor commits.
  // For Phase 3 we just park the run row manually so signalRun has
  // something to wake.
  await db()
    .update(agentRuns)
    .set({
      status: "waiting",
      wakeCondition: {
        kind: "hil",
        approvalId: stagedId,
        approvalKind: "action_staging",
        prompt: "Approve gmail.send_draft",
      },
    })
    .where(eq(agentRuns.id, runId2));

  // Approve via direct DB update (Phase 5 replaces this with the
  // /approvals decision API).
  await db()
    .update(actionStagings)
    .set({
      status: "approved",
      decidedAt: new Date(),
      rowVersion: gatedRow.rowVersion + 1,
    })
    .where(eq(actionStagings.id, stagedId));

  const woken = await signalRun({
    runId: runId2,
    match: {
      kind: "hil",
      approvalId: stagedId,
      approvalKind: "action_staging",
    },
  });
  assert(
    woken === true,
    "signalRun on a freshly-parked HIL wake must return true",
  );

  // Re-dispatch with the same tool_call_id — the dispatcher reads the
  // 'approved' row, executes the tool, and updates the row. Critically,
  // the caller passes a DIFFERENT `input` than what was staged + approved.
  // The dispatcher must ignore the caller's input and execute against
  // the row's stored `proposed_input` — otherwise a buggy/malicious
  // caller could slip an unapproved payload past the gate via resume.
  const resumed = await dispatchToolCall({
    runId: runId2,
    stepId: "turn-1",
    toolCallId: "tc_draft_gated",
    toolName: "gmail.send_draft",
    input: {
      to: ["attacker@example.com"],
      subject: "smuggled payload",
      bodyText: "should not run",
    },
    userId,
  });
  assert(
    resumed.kind === "executed",
    `resume expected 'executed', got '${resumed.kind}'`,
  );
  assert(
    (resumed as { toolResult: { sentTo: string } }).toolResult.sentTo ===
      "yash@example.com",
    "approved resume must execute the STAGED proposed_input, not the caller's new input",
  );
  assert(
    stubs.draftExecCount() === 1,
    "approved tool should execute exactly once on resume",
  );
  const resumedRow = (
    await db()
      .select()
      .from(actionStagings)
      .where(eq(actionStagings.id, stagedId))
  )[0];
  assert(
    resumedRow?.status === "executed",
    `resumed row expected 'executed', got '${resumedRow?.status}'`,
  );
  console.log(
    "[smoke-dispatch] 2. gated: approved + signal → executed, tool fired once ✓",
  );

  // ─── 3. Retry-suppression ────────────────────────────────────────────
  const runId3 = await createSmokeRun(userId, "retry-suppression-turn");
  const firstAttempt = await dispatchToolCall({
    runId: runId3,
    stepId: "turn-1",
    toolCallId: "tc_draft_rs_1",
    toolName: "gmail.send_draft",
    input: {
      to: ["someone@example.com"],
      subject: "do not send",
      bodyText: "no",
    },
    userId,
  });
  assert(
    firstAttempt.kind === "staged",
    "retry-suppression setup expects staged on first try",
  );
  const firstAttemptId = (firstAttempt as { stagingId: string }).stagingId;

  // User rejects with a reason — Phase 5's decision API would do this.
  await db()
    .update(actionStagings)
    .set({
      status: "rejected",
      rejectReason: "wrong recipient",
      decidedAt: new Date(),
    })
    .where(eq(actionStagings.id, firstAttemptId));

  const draftExecBefore = stubs.draftExecCount();
  // Model proposes the SAME tool_name + input under a fresh tool_call_id —
  // this is the path retry-suppression targets.
  const reproposed = await dispatchToolCall({
    runId: runId3,
    stepId: "turn-2",
    toolCallId: "tc_draft_rs_2",
    toolName: "gmail.send_draft",
    input: {
      to: ["someone@example.com"],
      subject: "do not send",
      bodyText: "no",
    },
    userId,
  });
  assert(
    reproposed.kind === "rejected",
    `retry-suppression expected 'rejected', got '${reproposed.kind}'`,
  );
  assert(
    (reproposed as { stagingId: string | null }).stagingId === null,
    "retry-suppression must NOT write a new staging row",
  );
  assert(
    (reproposed as { result: { retryPolicy: string } }).result.retryPolicy ===
      "do_not_retry_identical",
    "retry-suppression result must carry retryPolicy='do_not_retry_identical'",
  );
  assert(
    stubs.draftExecCount() === draftExecBefore,
    "retry-suppression must not execute the tool",
  );
  const allRsRows = await db()
    .select()
    .from(actionStagings)
    .where(eq(actionStagings.runId, runId3));
  assert(
    allRsRows.length === 1,
    `retry-suppression must keep only the original row, got ${allRsRows.length}`,
  );
  console.log(
    "[smoke-dispatch] 3. retry-suppression: no new row, synthesized rejection ✓",
  );

  // ─── 4. cancelRun idempotency ────────────────────────────────────────
  const runId4 = await createSmokeRun(userId, "cancel-turn");
  await db()
    .insert(actionStagings)
    .values([
      {
        userId,
        runId: runId4,
        stepId: "turn-1",
        toolCallId: "tc_cancel_1",
        toolName: "gmail.send_draft",
        integration: "gmail",
        riskTier: "high",
        proposedInput: {
          to: ["one@example.com"],
          subject: "cancel",
          bodyText: "one",
        },
        proposedInputHash: "smoke-cancel-1",
        requiresApproval: true,
        status: "pending",
      },
      {
        userId,
        runId: runId4,
        stepId: "turn-1",
        toolCallId: "tc_cancel_2",
        toolName: "gmail.send_draft",
        integration: "gmail",
        riskTier: "high",
        proposedInput: {
          to: ["two@example.com"],
          subject: "cancel",
          bodyText: "two",
        },
        proposedInputHash: "smoke-cancel-2",
        requiresApproval: true,
        status: "pending",
      },
    ]);
  const first = await cancelRun({ runId: runId4, reason: "smoke" });
  assert(
    first === "cancelled",
    `cancelRun first call expected 'cancelled', got '${first}'`,
  );
  const cancelledRow = (
    await db().select().from(agentRuns).where(eq(agentRuns.id, runId4))
  )[0];
  assert(cancelledRow?.status === "cancelled", "run row should be 'cancelled'");
  assert(cancelledRow.endedAt != null, "cancelled row should carry ended_at");
  assert(
    (cancelledRow.error as { reason: string } | null)?.reason === "smoke",
    "cancelled row should record the reason",
  );
  const cancelledStagings = await db()
    .select()
    .from(actionStagings)
    .where(eq(actionStagings.runId, runId4));
  assert(
    cancelledStagings.every(
      (row) => row.status === "rejected" && row.rejectReason === "smoke",
    ),
    "cancelRun should reject pending approval staging rows for the run",
  );
  const second = await cancelRun({ runId: runId4, reason: "smoke" });
  assert(
    second === "already_terminal",
    `cancelRun second call expected 'already_terminal', got '${second}'`,
  );
  const missing = await cancelRun({
    runId: "run_does_not_exist",
    reason: "smoke",
  });
  assert(
    missing === "not_found",
    `cancelRun on missing row expected 'not_found', got '${missing}'`,
  );
  console.log("[smoke-dispatch] 4. cancelRun: idempotent ✓");

  // ─── cleanup ─────────────────────────────────────────────────────────
  for (const runId of [runId1, runId2, runId3, runId4]) {
    await db().delete(actionStagings).where(eq(actionStagings.runId, runId));
    await db()
      .delete(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
  }
  console.log("[smoke-dispatch] cleanup ok");
}

try {
  await main();
  console.log("[smoke-dispatch] PASS");
} catch (err) {
  console.error("[smoke-dispatch] FAIL", err);
  process.exitCode = 1;
} finally {
  await closeRedis();
  await closeConnections();
}

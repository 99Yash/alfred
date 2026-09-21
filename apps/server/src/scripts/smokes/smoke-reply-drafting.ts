/**
 * Reply drafting tracer (#237, ADR-0098).
 *
 * pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-reply-drafting.ts
 * Optional: --document <id> --invocation post_triage --expect staged
 *
 * Requires a worker running this checkout. Defaults to a manual run on the
 * newest reply-expected triage row. It can create a pending approval but never
 * approves it. For a cold fixture use --invocation post_triage --expect no_draft;
 * for a disabled flag use the same invocation and inspect feature_disabled.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { closeAgentQueue, startRun } from "@alfred/assistant/execution";
import {
  REPLY_DRAFTING_WORKFLOW_SLUG,
  type ReplyDraftingWorkflowInput,
} from "@alfred/assistant/reply-drafting";
import {
  REPLY_EXPECTED_TRIAGE_CATEGORIES,
  gmailSendDraftInput,
  replyDraftInvocationSchema,
  replyDraftOutcomeSchema,
  replyDraftResultSchema,
} from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { actionStagings, agentRuns, emailTriage } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const POLL_INTERVAL_MS = 250;

const POLL_TIMEOUT_MS = 180_000;

const options = z
  .object({
    document: z.string().min(1).optional(),
    invocation: replyDraftInvocationSchema.default("manual"),
    expect: replyDraftOutcomeSchema.optional(),
  })
  .parse(
    parseArgs({
      options: {
        document: { type: "string" },
        invocation: { type: "string" },
        expect: { type: "string" },
      },
    }).values,
  );

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function pickReplyExpectedTriageRow() {
  const rows = await db()
    .select({
      userId: emailTriage.userId,
      documentId: emailTriage.documentId,
      sourceThreadId: emailTriage.sourceThreadId,
      category: emailTriage.category,
      confidence: emailTriage.confidence,
      model: emailTriage.model,
    })
    .from(emailTriage)
    // `document_id` is a soft pointer that a purge can null; the run needs a document.
    .where(
      and(
        inArray(emailTriage.category, [...REPLY_EXPECTED_TRIAGE_CATEGORIES]),
        isNotNull(emailTriage.documentId),
        options.document ? eq(emailTriage.documentId, options.document) : undefined,
      ),
    )
    .orderBy(desc(emailTriage.updatedAt))
    .limit(1);

  return rows[0] ?? null;
}

async function pollRun(runId: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const [row] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));

    if (!row) throw new Error(`run ${runId} not found`);

    if (
      row.status === "waiting" ||
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return row;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`timed out waiting for run ${runId}`);
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const row = await pickReplyExpectedTriageRow();

  if (!row || row.documentId === null) {
    console.log(
      `[smoke-reply-drafting] no email_triage row with category in ${REPLY_EXPECTED_TRIAGE_CATEGORIES.join("|")}; triage an inbox first`,
    );
    throw new Error("No matching triaged Gmail document; smoke was not run.");
  }

  console.log(
    `[smoke-reply-drafting] target thread=${row.sourceThreadId} doc=${row.documentId} ` +
      `category=${row.category} confidence=${row.confidence.toFixed(2)} model=${row.model}`,
  );

  const input: ReplyDraftingWorkflowInput = {
    documentId: row.documentId,
    sourceThreadId: row.sourceThreadId,
    invocation: options.invocation,
  };

  const { runId } = await startRun({
    userId: row.userId,
    workflowSlug: REPLY_DRAFTING_WORKFLOW_SLUG,
    input,
    metadata: { source: "smoke-reply-drafting" },
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

  console.log(`[smoke-reply-drafting] run enqueued: ${runId}`);

  const run = await pollRun(runId);
  assert(run.status === "completed" || run.status === "waiting", `run status=${run.status}`);

  const result =
    run.status === "waiting"
      ? z.object({ result: replyDraftResultSchema }).parse(run.state).result
      : replyDraftResultSchema.parse(run.output);

  console.log(`[smoke-reply-drafting] outcome=${result.outcome}`);

  if (result.outcome === "no_draft") {
    console.log(`[smoke-reply-drafting] reason=${result.reason} note=${result.note ?? "-"}`);
  } else if (result.outcome === "no_access" || result.outcome === "withheld") {
    console.log(`[smoke-reply-drafting] reason=${result.reason}`);
  }

  console.log(
    `[smoke-reply-drafting] provenance: invocation=${result.provenance.invocation} ` +
      `flag=${result.provenance.featureFlagEnabled} sender=${result.provenance.sender ?? "-"} ` +
      `style=${result.provenance.style?.kind ?? "-"} to=${result.provenance.recipients.to.join(",") || "-"}`,
  );
  assert(
    result.provenance.invocation === options.invocation,
    "provenance must record the invocation",
  );

  if (options.expect)
    assert(result.outcome === options.expect, `expected ${options.expect}, got ${result.outcome}`);
  const staged = await db().select().from(actionStagings).where(eq(actionStagings.runId, runId));

  if (result.outcome === "staged") {
    assert(run.status === "waiting", "staged run must wait for approval");
    assert(staged.length === 1, "exactly one approval row must exist");
    const action = staged[0];
    assert(action && action.id === result.stagingId, "result must identify its approval row");
    assert(
      action.status === "pending" && action.requiresApproval,
      "action must require approval and remain pending",
    );
    assert(action.toolName === "gmail.send_draft", "approval must be for the Gmail send tool");
    const input = gmailSendDraftInput.parse(action.proposedInput);
    assert(input.threadId === row.sourceThreadId, "approval must target the source thread");
    assert(
      input.to.length === 1 && input.to[0] === result.provenance.sender,
      "recipient must be the inbound sender",
    );
    assert(
      input.bodyText.trim().length > 0 && input.subject.length > 0,
      "approval must carry a body and subject",
    );
    assert(
      result.provenance.inbound.documentId === row.documentId,
      "source document must be preserved",
    );
    assert(result.provenance.verifier?.decision === "pass", "staging requires a verifier pass");
    assert(result.provenance.style !== null, "style selection or style_missing must be recorded");
    console.log(
      `[smoke-reply-drafting] pending approval=${action.id}; review or reject it in Alfred`,
    );
  } else {
    assert(
      staged.every((action) => action.status === "rejected" && action.outcome === "refused"),
      "a non-staged decision must leave no approval or send; recovered rows must be withdrawn",
    );
  }

  console.log("\n[smoke-reply-drafting] PASS");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-reply-drafting] FAIL",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources(closeAgentQueue);
  });

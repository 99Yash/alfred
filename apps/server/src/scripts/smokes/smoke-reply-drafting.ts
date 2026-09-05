/**
 * Smoke test for the `reply-drafting` workflow foundation (#243, ADR-0097).
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-reply-drafting.ts
 *
 * Pre-req: a server process running (`pnpm dev`) so the agent worker can pick
 * up the run, and at least one `email_triage` row with a reply-expected category
 * (run smoke-triage.ts or let the inbox triage first).
 *
 * What this verifies end-to-end:
 *   1. A `manual` run of `reply-drafting` walks gate → gather → compose and
 *      completes (never fails) on a real triaged thread.
 *   2. The run output parses as a `ReplyDraftResult` — one of the five typed
 *      outcomes — and its provenance records `invocation: "manual"`.
 *   3. At #243 the expected terminal outcome is `no_draft` (structural blocker,
 *      or `composer_unavailable` once the gate and access check pass) or
 *      `no_access` when the mailbox lacks `gmail.send`. A `staged` outcome is
 *      impossible until #237 adds a composer.
 *
 * No Gmail mutation happens here: the run never reaches a staging call.
 */
import { randomUUID } from "node:crypto";
import { closeAgentQueue, startRun } from "@alfred/assistant/execution";
import {
  REPLY_DRAFTING_WORKFLOW_SLUG,
  type ReplyDraftingWorkflowInput,
} from "@alfred/assistant/reply-drafting";
import { REPLY_EXPECTED_TRIAGE_CATEGORIES, replyDraftResultSchema } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { agentRuns, emailTriage } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 90_000;

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
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
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
    return;
  }
  console.log(
    `[smoke-reply-drafting] target thread=${row.sourceThreadId} doc=${row.documentId} ` +
      `category=${row.category} confidence=${row.confidence.toFixed(2)} model=${row.model}`,
  );

  const input: ReplyDraftingWorkflowInput = {
    documentId: row.documentId,
    sourceThreadId: row.sourceThreadId,
    invocation: "manual",
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
  assert(run.status === "completed", `run status=${run.status} error=${JSON.stringify(run.error)}`);

  const result = replyDraftResultSchema.parse(run.output);
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
  assert(result.provenance.invocation === "manual", "provenance must record the manual invocation");
  assert(result.outcome !== "staged", "#243 has no composer; a staged outcome is impossible");

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

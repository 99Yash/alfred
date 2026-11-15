/**
 * Reply drafting tracer (#237, ADR-0098, amended 2026-11-15).
 *
 * pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-reply-drafting.ts
 * Optional: --document <id> --invocation post_triage --expect staged
 *
 * Requires a worker running this checkout. Defaults to a manual run on the
 * newest reply-expected triage row. On a verifier pass the run CREATES A GMAIL
 * DRAFT on the source thread; no approval is staged and nothing is sent.
 * For a cold fixture use --invocation post_triage --expect no_draft;
 * for a disabled flag use the same invocation and inspect feature_disabled.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { agentQueue, startRun } from "@alfred/assistant/execution";
import type { ReplyDraftingWorkflowInput } from "@alfred/assistant/reply-drafting";
import {
  REPLY_EXPECTED_TRIAGE_CATEGORIES,
  replyDraftInvocationSchema,
  replyDraftOutcomeSchema,
  replyDraftResultSchema,
  REPLY_DRAFTING_WORKFLOW_SLUG,
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
    // A purge can null `document_id`, and the run needs a document.
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
    assert(run.status === "completed", "a drafted run completes; nothing waits for approval");
    assert(
      staged.every((action) => action.status === "rejected" && action.outcome === "refused"),
      "a drafted run must leave no live approval; recovered rows must be withdrawn",
    );

    assert(result.draftId !== undefined, "the result names the created draft");

    const provenance = z.object({ verifier: z.unknown() }).parse(result.provenance);
    assert(
      result.provenance.inbound.documentId === row.documentId,
      "source document must be preserved",
    );
    assert(
      provenance.verifier !== null &&
        typeof provenance.verifier === "object" &&
        (provenance.verifier as { decision?: string }).decision === "pass",
      "a draft requires a verifier pass",
    );
    assert(result.provenance.style !== null, "style selection or style_missing must be recorded");
    assert(result.provenance.recipients.to.length > 0, "a draft names its recipients");
    console.log(
      `[smoke-reply-drafting] created Gmail draft ${result.draftId}; review and send it in Gmail`,
    );
  } else {
    assert(
      staged.every((action) => action.status === "rejected" && action.outcome === "refused"),
      "a non-drafted decision must leave no approval or send; recovered rows must be withdrawn",
    );
  }

  console.log("\n[smoke-reply-drafting] PASS");
}

try {
  await main();
} catch (err) {
  console.error(
    "[smoke-reply-drafting] FAIL",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exitCode = 1;
} finally {
  await closeScriptResources(agentQueue.close);
}

/**
 * Re-run the real `email-triage` workflow over named Gmail threads (#1099).
 * It enqueues onto the prod BullMQ queue, so the prod worker runs every step.
 *
 * Not `backfill-triage-committed.ts`: that script deletes every agent todo for the user.
 * Preview the old and new category with `dry-run-triage-recategorize-committed.ts`
 * and `RECAT_THREAD_IDS`.
 *
 * Limits:
 *  - The sender prior keeps its old vote. A second bump would count one mail twice.
 *  - A stale agent todo is printed, not deleted. A human decides.
 *  - A row with `source != 'auto'` is skipped. `apply-label` ignores `source`, so a
 *    re-run would still do a live Gmail write of the user's own category.
 *
 * Runs on prod where Redis is reachable (bundled, no `tsx` in the image). Dry by default.
 * `--commit` enqueues, and refuses when Gmail mailbox writes are disabled.
 *
 *   # preview (writes nothing):
 *   TRIAGE_REPAIR_THREAD_IDS=19a1b2c3d4e5f6a7,19b2c3d4e5f6a7b8 \
 *     node dist/scripts/repairs/repair-triage-sender-miss-committed.js
 *   # repair:
 *   TRIAGE_REPAIR_THREAD_IDS=19a1b2c3d4e5f6a7,19b2c3d4e5f6a7b8 \
 *     node dist/scripts/repairs/repair-triage-sender-miss-committed.js --commit
 */
import { randomUUID } from "node:crypto";
import { closeAgentQueue, startRun } from "@alfred/assistant/execution";
import { TRIAGE_WORKFLOW_SLUG, type TriageWorkflowInput } from "@alfred/assistant/triage";
import { toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import {
  documents,
  emailTriage,
  todos,
  user as userTable,
  type EmailTriage,
} from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import { and, eq, inArray } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

/** Required. No default scope: a repair with an implicit target set is a backfill. */
const THREAD_IDS = (process.env.TRIAGE_REPAIR_THREAD_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * `source` keeps the {@link EmailTriage} type, so a renamed member breaks the
 * `!== "auto"` skip at compile time. The skip is an allow-list, like the preview.
 */
interface ThreadPlan {
  threadId: string;
  userId: string;
  email: string;
  category: EmailTriage["category"];
  source: EmailTriage["source"];
  documentId: string | null;
  appliedLabelId: string | null;
  model: string;
  /** False when the document was purged. */
  documentPresent: boolean;
}

async function loadPlans(): Promise<ThreadPlan[]> {
  const rows = await db()
    .select({
      threadId: emailTriage.sourceThreadId,
      userId: emailTriage.userId,
      email: userTable.email,
      category: emailTriage.category,
      source: emailTriage.source,
      documentId: emailTriage.documentId,
      appliedLabelId: emailTriage.appliedLabelId,
      model: emailTriage.model,
    })
    .from(emailTriage)
    .innerJoin(userTable, eq(userTable.id, emailTriage.userId))
    .where(inArray(emailTriage.sourceThreadId, THREAD_IDS));

  const docIds = rows.map((row) => row.documentId).filter((id): id is string => id !== null);

  // `document_id` has no foreign key, so it can outlive a purged document.
  const live =
    docIds.length === 0
      ? []
      : await db()
          .select({ id: documents.id })
          .from(documents)
          .where(inArray(documents.id, docIds));

  const liveIds = new Set(live.map((doc) => doc.id));

  return rows.map((row) => ({
    ...row,
    documentPresent: row.documentId !== null && liveIds.has(row.documentId),
  }));
}

/** Agent-authored todos whose provenance names one of the selected threads. */
async function agentTodosForThreads(
  userId: string,
  threadIds: Set<string>,
): Promise<Array<{ id: string; name: string; threadId: string }>> {
  const rows = await db()
    .select({ id: todos.id, name: todos.name, sources: todos.sources })
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.createdBy, "agent")));

  const matched: Array<{ id: string; name: string; threadId: string }> = [];

  for (const row of rows) {
    for (const source of row.sources) {
      if (source.provider !== "gmail" || source.kind !== "thread") continue;

      if (threadIds.has(source.id))
        matched.push({ id: row.id, name: row.name, threadId: source.id });
    }
  }

  return matched;
}

async function main() {
  if (THREAD_IDS.length === 0) {
    throw new Error(
      "[repair-triage-sender-miss] set TRIAGE_REPAIR_THREAD_IDS to a comma-separated list of Gmail thread ids; this script has no default scope",
    );
  }

  if (COMMIT && !gmailMailboxWritesEnabled()) {
    throw new Error(
      "[repair-triage-sender-miss] refuses to re-triage while Gmail mailbox writes are disabled — the enqueued run ends in a live label write; set GMAIL_MAILBOX_WRITES_ENABLED=true for a committed repair",
    );
  }

  await warmPool();
  registerBuiltinWorkflows(); // createRun resolves builtins from the in-process registry
  // No poke adapter: `startRun` emits no poke, and the prod worker does the writes.

  console.log(
    `# Sender-miss triage repair (#1099) — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `${THREAD_IDS.length} thread(s) requested`,
  );

  const plans = await loadPlans();
  const found = new Set(plans.map((plan) => plan.threadId));

  for (const threadId of THREAD_IDS) {
    if (!found.has(threadId)) {
      console.log(`  ! ${threadId}: NO email_triage row — nothing to re-triage`);
    }
  }

  const runnable: ThreadPlan[] = [];

  for (const plan of plans) {
    console.log(
      `\n  ${plan.threadId} (${plan.email})\n` +
        `    category=${plan.category} source=${plan.source} model=${plan.model}\n` +
        `    document=${plan.documentId ?? "(none)"}${plan.documentPresent ? "" : " [MISSING]"} ` +
        `label=${plan.appliedLabelId ?? "(none)"}`,
    );

    if (plan.source !== "auto") {
      console.log(
        `    → SKIP: source='${plan.source}', and this repair re-runs auto rows only — the same ` +
          `allow-list the preview reads. On the 'user' row that means the user overrode this ` +
          `tag: upsertTriage returns written=false on it and reconcileThreadLabel re-reads it ` +
          `under the lock, so a re-run cannot move the label. The classify step's own side ` +
          `effects are written-gated, but apply-label is a sibling step that reads neither ` +
          `written nor source: on prod the enqueue costs one wasted model call AND a live ` +
          `Gmail write that re-applies the user's own category and bumps row_version.`,
      );
      continue;
    }

    if (!plan.documentPresent) {
      console.log(
        `    → SKIP: no live document behind this row, so there is nothing to re-classify. ` +
          `This is a PURGE, not a routine gap: upsertTriage is the only INSERTER of ` +
          `email_triage and UpsertTriageArgs.documentId is a required string, so every row was ` +
          `born naming a document. (Four other production writers UPDATE the table — the Gmail ` +
          `reconcile repoint, setAppliedLabelId, setTriageReconciledTarget and the user tag ` +
          `override. Two of them move document_id; none can create a row, and none can null ` +
          `the column.) A thread that was ` +
          `never ingested prints 'NO email_triage row' above. Re-ingest the thread if you need ` +
          `it re-classified.`,
      );
      continue;
    }

    runnable.push(plan);
    console.log(`    → WOULD ENQUEUE email-triage (reason=manual, force=true)`);
  }

  // A forced re-run re-mints todos but never deletes. Only runnable threads carry that risk.
  const byUser = new Map<string, Set<string>>();

  for (const plan of runnable) {
    const threads = byUser.get(plan.userId) ?? new Set<string>();

    threads.add(plan.threadId);
    byUser.set(plan.userId, threads);
  }

  for (const [userId, threadIds] of byUser) {
    const stale = await agentTodosForThreads(userId, threadIds);

    if (stale.length === 0) continue;

    console.log(
      `\n  agent todos behind these threads (user=${userId}) — a re-run RE-MINTS but never deletes:`,
    );

    for (const todo of stale) {
      console.log(`    todo=${todo.id} thread=${todo.threadId} | ${todo.name.slice(0, 70)}`);
    }

    console.log(`    → deleting a stale one is a HUMAN call; this script does not.`);
  }

  if (!COMMIT) {
    console.log(
      `\n# DRY — ${runnable.length} of ${THREAD_IDS.length} thread(s) are re-triageable. ` +
        `Pass --commit to enqueue.`,
    );

    return;
  }

  let enqueued = 0;
  let errors = 0;

  for (const plan of runnable) {
    if (!plan.documentId) continue;

    try {
      await startRun({
        userId: plan.userId,
        workflowSlug: TRIAGE_WORKFLOW_SLUG,
        // `force` bypasses the already-tagged skip, or the repair is a no-op.
        // `satisfies` rejects a misspelt key, which the parse would drop silently.
        input: {
          documentId: plan.documentId,
          reason: "manual",
          force: true,
        } satisfies TriageWorkflowInput,
        metadata: { source: "repair-triage-sender-miss-committed" },
        trigger: { kind: "manual" },
        occurrence: { kind: "manual", requestId: randomUUID() },
      });
      enqueued++;
      console.log(`  enqueued ${plan.threadId} (doc=${plan.documentId})`);
    } catch (err) {
      errors++;
      console.log(`  ! enqueue failed for ${plan.threadId}: ${toMessage(err)}`);
    }
  }

  console.log(
    `\n# DONE — enqueued ${enqueued} triage run(s), ${errors} error(s). The worker executes them; ` +
      `re-read email_triage.category / applied_label_id and the live Gmail label to confirm.`,
  );
}

main()
  .catch((e) => {
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources(closeAgentQueue);
  });

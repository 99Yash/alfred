/**
 * COMMITTED thread-scoped re-triage for the sender-not-phrases fix (#1099).
 *
 * Re-runs the real `email-triage` workflow over a NAMED set of Gmail threads, so
 * a thread that was tagged before #1097/#1098 landed converges onto the current
 * classifier and the Gmail label follows. Enqueues onto the same BullMQ queue
 * the prod `server` worker consumes, so classify → upsertTriage → suggestTodo →
 * apply-label runs exactly as in production.
 *
 * WHY NOT `backfill-triage-committed.ts`. That script DELETES every
 * `created_by='agent'` todo for the user before it enqueues, and it scopes by
 * mailbox plus recency — it has no thread selector at all. Running it to repair
 * two threads would destroy the user's whole agent todo set. Its contract is
 * "delete every agent todo, then re-triage a window"; a second mode that skips
 * the delete would make one script mean two things.
 *
 * WHAT IT DOES NOT DO.
 *
 *  - It does not re-classify locally and print a diff. That belongs to
 *    `../dry-runs/dry-run-triage-recategorize-committed.ts`, which already
 *    assembles the classify context; set `RECAT_THREAD_IDS` to the same thread
 *    ids to see the old→new diff BEFORE committing here.
 *  - It does not delete a stale todo. A forced re-run re-runs `suggestTodo` but
 *    does NOT remove the todo the previous classification minted, so a thread
 *    moving out of a demand lane can leave one behind. This script PRINTS every
 *    agent-authored todo behind a RE-TRIAGEABLE thread and leaves the delete to
 *    the human — that is the one judgment a repair script must not take.
 *  - It does not touch a user-overridden row. `upsertTriage` returns at its
 *    read side with `written: false` on a `source = 'user'` row
 *    (`store.ts:197`), and `reconcileThreadLabel` re-reads the stored row inside
 *    the thread lock, so Gmail converges on the USER's category either way.
 *    The `written` gate covers the classify step's own side effects: no todo,
 *    no `inbox.updated`, no `email-triage.classified`, no sender prior and no
 *    decision trace. It does NOT cover the Gmail write. `classify` returns
 *    `nextStep: "apply-label"` unconditionally (`workflow-operations.ts:739`),
 *    and `apply-label` is a SIBLING step that reads neither `written` nor
 *    `source`. It re-applies the stored row's category to the target message,
 *    strips every Alfred label off the thread's siblings
 *    (`stripAllAlfredLabels: true`, `tags.ts:146`), and bumps `row_version`
 *    through `setAppliedLabelId` / `setTriageReconciledTarget`. Two gates stop
 *    that write and neither of them reads `source`: the `emailTagging` feature
 *    flag, and `gmailMailboxWritesEnabled()`. So on prod the enqueue costs one
 *    wasted model call AND a live mailbox write of the category the user
 *    already chose. That is why this script skips the row loudly.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/repairs/repair-triage-sender-miss-committed.js` — the prod
 * image has no `tsx`/loose `@alfred/*` sources. It must run WHERE prod Redis is
 * reachable, and `startRun` runs the workflow's `initialState` in-process before
 * it enqueues. It does NOT need the current prompt: `createRun` writes
 * `workflowRevisionId: null` for a builtin, so the prod worker supplies the
 * prompt at execute time whatever machine enqueued the run.
 *
 * Dry by default: it reads, prints the plan, and writes nothing. `--commit`
 * enqueues, and REFUSES when Gmail mailbox writes are disabled — the enqueued
 * workflow ends in a live label write.
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

/**
 * Gmail thread ids to re-triage, comma-separated. Required — this script has no
 * default scope on purpose: a repair with an implicit target set is a backfill.
 */
const THREAD_IDS = (process.env.TRIAGE_REPAIR_THREAD_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * One selected thread, with everything needed to decide whether it can be re-run.
 *
 * `category` and `source` are read off {@link EmailTriage}, not re-typed as
 * `string`. `source` carries the whole user-authority invariant this script
 * claims to honour, so `plan.source !== "auto"` must be a comparison the
 * compiler checks: widened to `string` it would keep compiling after the member
 * is renamed, and the skip would silently stop firing.
 *
 * The test is an ALLOW-list, matching the preview's `eq(emailTriage.source,
 * "auto")` in `../dry-runs/dry-run-triage-recategorize-committed.ts`. A deny-list
 * (`=== "user"`) agrees with the preview only while `TRIAGE_TAG_SOURCES` has two
 * members: add a third and the preview would drop that row and report it while
 * this script enqueued it in silence, into a live Gmail label write.
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
  /** False when `document_id` is a dead soft pointer — the doc was purged. */
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

  // `email_triage.document_id` is a soft pointer with NO foreign key: it outlives
  // the document being purged, so a row can name a document that is not there.
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
  // NO poke adapter is registered here, unlike the sibling committed scripts.
  // `startRun` is `createRun` + `enqueueRun`; neither emits a Replicache poke
  // (the only `pokeWorkflowOwner` call in execution's service sits in
  // `cancelRunInTx`). The enqueued run's own writes happen in the prod `server`
  // worker, which registers its adapter at boot. Registering one in this
  // short-lived process would be dead code.

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

  // Stale agent todos: a forced re-run re-mints, it never deletes. Print them so
  // the human can decide; deleting one is not this script's call.
  //
  // Scoped to `runnable`, not `plans`. A SKIPPED thread never reaches classify,
  // or reaches it and lands on a `written: false` row, so nothing re-mints its
  // todos — printing them under this banner would claim a risk that path does
  // not carry.
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
        // `force`: bypass the already-tagged skip guard (the ONLY thing it
        // bypasses). Without it a thread still sitting on the message it was
        // last classified from skips and the repair is a no-op.
        //
        // `satisfies` is load-bearing. `WorkflowInput.input` is `unknown` and
        // `force` is OPTIONAL in `triageWorkflowInputSchema`, so a misspelt key
        // would parse, drop, and make the whole repair a silent no-op that
        // still prints `enqueued`. The excess-property check rejects it here.
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources(closeAgentQueue);
  });

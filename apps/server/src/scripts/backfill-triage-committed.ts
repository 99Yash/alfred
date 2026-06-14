/**
 * COMMITTED triage + todo backfill (one-off, 2026-06-09).
 *
 * The merged `dry-run-triage-backfill.ts` is READ-ONLY — it re-classifies the
 * source email of every agent todo and prints KEEP/KILL. This is its committing
 * sibling: it actually re-runs the production `email-triage` workflow (classify
 * → upsertTriage + suggestTodo + sender-prior → apply-label / Gmail re-tag) over
 * a target set of threads, after first deleting the stale agent-authored todos.
 *
 * Scope (per target user):
 *   - DELETE every `created_by='agent'` todo (suggested + open + done).
 *   - Re-triage the UNION of:
 *       (a) the N most recent Gmail threads (newest doc per thread), and
 *       (b) every thread behind a (now-deleted) agent todo's gmail source.
 *     Enqueueing the real workflow re-tags Gmail AND re-mints todos under the
 *     new stringency bar.
 *
 * Execution model: this enqueues runs onto the SAME BullMQ queue the prod
 * `server` worker consumes, so the workflow executes in the worker exactly as
 * in production. It is bundled by tsdown (`noExternal: @alfred/*`) so it runs on
 * prod with plain `node dist/scripts/backfill-triage-committed.js` — the prod
 * image has no `tsx`/loose `@alfred/*` sources.
 *
 * SAFETY: dry by default. Pass `--commit` to actually delete + enqueue.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfill-triage-committed.js
 *   # commit:
 *   node dist/scripts/backfill-triage-committed.js --commit
 */
import {
  closeAgentQueue,
  closeConnections,
  closeRedis,
  createRun,
  emitReplicachePokes,
  enqueueRun,
  TRIAGE_WORKFLOW_SLUG,
  warmPool,
} from "@alfred/api";
import { db, rowsFromExecute } from "@alfred/db";
import { documents, todos, user as userTable } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";

/** Mailboxes to backfill. */
const TARGET_EMAILS = ["yash.k@oliv.ai", "yashgouravkar@gmail.com"];
/**
 * Newest doc per thread, most-recent N threads. Defaults to 50; override with
 * `BACKFILL_RECENT_LIMIT` (e.g. the 2026-06-10 re-run scoped to 100 each).
 */
const RECENT_THREAD_LIMIT = Number(process.env.BACKFILL_RECENT_LIMIT) || 50;
const RECENT_DOCUMENT_SCAN_LIMIT = RECENT_THREAD_LIMIT * 4;

const COMMIT = process.argv.includes("--commit");

interface TargetUser {
  userId: string;
  email: string;
}

/** Newest gmail document id for each target thread, plus the recency-ordered thread list. */
async function buildThreadIndex(
  userId: string,
  todoThreads: Set<string>,
): Promise<{
  newestDocByThread: Map<string, string>;
  recentThreads: string[];
}> {
  type ThreadDocRow = { id: string; threadId: string };

  const newestDocByThread = new Map<string, string>();

  const recentDocs = await db()
    .select({
      id: documents.id,
      threadId: documents.sourceThreadId,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        isNotNull(documents.sourceThreadId),
      ),
    )
    // nulls last so a dateless doc never shadows a real newest message
    .orderBy(sql`${documents.authoredAt} desc nulls last`, desc(documents.id))
    .limit(RECENT_DOCUMENT_SCAN_LIMIT);

  const recentThreads: string[] = [];
  for (const d of recentDocs) {
    if (!d.threadId) continue;
    if (newestDocByThread.has(d.threadId)) continue;
    newestDocByThread.set(d.threadId, d.id);
    recentThreads.push(d.threadId);
    if (recentThreads.length >= RECENT_THREAD_LIMIT) break;
  }

  const missingTodoThreads = [...todoThreads].filter((thread) => !newestDocByThread.has(thread));
  if (missingTodoThreads.length > 0) {
    const missingTodoThreadList = sql.join(
      missingTodoThreads.map((thread) => sql`${thread}`),
      sql`, `,
    );
    const todoDocs = rowsFromExecute<ThreadDocRow>(
      await db().execute(sql`
        WITH ranked_gmail_docs AS (
          SELECT
            id,
            source_thread_id AS "threadId",
            row_number() OVER (
              PARTITION BY source_thread_id
              ORDER BY authored_at DESC NULLS LAST, id DESC
            ) AS rn
          FROM documents
          WHERE user_id = ${userId}
            AND source = 'gmail'
            AND source_thread_id IN (${missingTodoThreadList})
        )
        SELECT id, "threadId"
        FROM ranked_gmail_docs
        WHERE rn = 1
      `),
    );

    for (const d of todoDocs) newestDocByThread.set(d.threadId, d.id);
  }

  return { newestDocByThread, recentThreads };
}

/** Gmail-thread ids referenced by this user's agent todos. */
async function agentTodoThreads(userId: string): Promise<{ ids: string[]; threads: Set<string> }> {
  const rows = await db()
    .select({ id: todos.id, sources: todos.sources })
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.createdBy, "agent")));

  const threads = new Set<string>();
  for (const t of rows) {
    const sources = Array.isArray(t.sources)
      ? (t.sources as Array<{ provider: string; kind: string; id: string }>)
      : [];
    for (const s of sources) {
      if (s.provider === "gmail" && s.kind === "thread") threads.add(s.id);
    }
  }
  return { ids: rows.map((r) => r.id), threads };
}

async function processUser(u: TargetUser): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  // Gather the agent-todo set + their source threads BEFORE deleting — the
  // delete is destructive and we need the thread list for the re-triage union.
  const { ids: agentTodoIds, threads: todoThreads } = await agentTodoThreads(u.userId);
  const { newestDocByThread, recentThreads } = await buildThreadIndex(u.userId, todoThreads);

  // Union: recent threads ∪ threads behind agent todos.
  const targetThreads = new Set<string>(recentThreads);
  for (const t of todoThreads) targetThreads.add(t);

  // Resolve each target thread to its newest local gmail doc. A todo whose
  // thread has no local document is skipped (mirrors the dry-run's behavior).
  const docIds: string[] = [];
  const missing: string[] = [];
  for (const thread of targetThreads) {
    const docId = newestDocByThread.get(thread);
    if (docId) docIds.push(docId);
    else missing.push(thread);
  }

  console.log(
    `  agent todos to delete: ${agentTodoIds.length}\n` +
      `  recent threads: ${recentThreads.length} | todo-source threads: ${todoThreads.size} | ` +
      `union: ${targetThreads.size}\n` +
      `  re-triage docs resolved: ${docIds.length}` +
      (missing.length ? ` (${missing.length} todo threads have no local doc — skipped)` : ""),
  );

  if (!COMMIT) {
    console.log("  [dry] no writes. Pass --commit to delete + enqueue.");
    return;
  }

  // 1) Delete all agent todos for this user.
  if (agentTodoIds.length > 0) {
    const deleted = await db()
      .delete(todos)
      .where(and(eq(todos.userId, u.userId), inArray(todos.id, agentTodoIds)))
      .returning({ id: todos.id });
    console.log(`  deleted ${deleted.length} agent todos`);
    // Poke so the rail drops the deleted rows immediately (the enqueued runs
    // would also poke via suggestTodo, but some threads mint nothing).
    emitReplicachePokes([u.userId]);
  }

  // 2) Enqueue a real email-triage run per target doc.
  let enqueued = 0;
  for (const documentId of docIds) {
    try {
      const { runId } = await createRun({
        userId: u.userId,
        workflowSlug: TRIAGE_WORKFLOW_SLUG,
        // `force`: bypass the already-tagged skip guard so threads still on the
        // message they were last classified from RE-classify here — otherwise a
        // backfill over a previously-triaged inbox skips everything and mints no
        // todos. Backfill-only; the real-time path never sets it.
        input: { documentId, reason: "manual", force: true },
        metadata: { source: "backfill-triage-committed-2026-06-09" },
        trigger: { kind: "manual" },
      });
      await enqueueRun(runId);
      enqueued++;
    } catch (err) {
      console.log(
        `  ! enqueue failed for doc=${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`  enqueued ${enqueued} triage runs (worker executes them)`);
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows(); // createRun resolves builtins from the in-process registry

  console.log(
    `# Committed triage backfill — mode=${COMMIT ? "COMMIT" : "DRY"} | recentLimit=${RECENT_THREAD_LIMIT}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));
  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
  }

  for (const u of users) await processUser(u);

  console.log("\n# done");
}

main()
  .catch((e) => {
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    // Flush + close so enqueued BullMQ jobs are durably persisted before exit.
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

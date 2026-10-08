/**
 * Delete every agent todo, then re-run the real `email-triage` workflow over a
 * thread set, so Gmail tags and todos follow the current rules. Its read-only
 * sibling is `dry-run-triage-backfill.ts`.
 *
 * Per user, it re-triages the N newest Gmail threads plus every thread behind a
 * deleted agent todo. The sender prior keeps its old vote: a second bump would
 * count one mail twice.
 *
 * It enqueues onto the prod BullMQ queue, so the prod worker runs the workflow.
 * Bundled for prod. Dry by default; `--commit` deletes and enqueues.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-triage-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-triage-committed.js --commit
 */
import { randomUUID } from "node:crypto";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { TRIAGE_WORKFLOW_SLUG } from "@alfred/assistant/triage";
import { registerReplicachePokeAdapter } from "@alfred/assistant/realtime";
import { warmPool } from "@alfred/db";
import { db, rowsFromExecute } from "@alfred/db";
import { documents, todos, user as userTable } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { toMessage } from "@alfred/contracts";
import { closeScriptResources } from "../script-runtime";

/** Override with comma-separated `BACKFILL_TARGET_EMAILS`. */
const TARGET_EMAILS = process.env.BACKFILL_TARGET_EMAILS?.split(",")
  .map((email) => email.trim())
  .filter(Boolean) ?? ["yash.k@oliv.ai", "yashgouravkar@gmail.com"];

/** Recent threads per mailbox. Override with `BACKFILL_RECENT_LIMIT`. */
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
    // Nulls last, so a dateless doc never hides the real newest message.
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
    // SAFETY: todos.sources holds { provider, kind, id } entries; Array.isArray gates the read.
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

  // Read the todo threads before the delete removes them.
  const { ids: agentTodoIds, threads: todoThreads } = await agentTodoThreads(u.userId);
  const { newestDocByThread, recentThreads } = await buildThreadIndex(u.userId, todoThreads);

  const targetThreads = new Set<string>(recentThreads);

  for (const t of todoThreads) targetThreads.add(t);

  // A thread with no local document is skipped.
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

  if (agentTodoIds.length > 0) {
    const deleted = await db()
      .delete(todos)
      .where(and(eq(todos.userId, u.userId), inArray(todos.id, agentTodoIds)))
      .returning({ id: todos.id });

    console.log(`  deleted ${deleted.length} agent todos`);
    // Some runs mint no todo and so never poke. Poke now so the rail drops the rows.
    emitReplicachePokes([u.userId]);
  }

  let enqueued = 0;

  for (const documentId of docIds) {
    try {
      await startRun({
        userId: u.userId,
        workflowSlug: TRIAGE_WORKFLOW_SLUG,
        // `force` bypasses the already-tagged skip. The real-time path never sets it.
        input: { documentId, reason: "manual", force: true },
        metadata: { source: "backfill-triage-committed" },
        trigger: { kind: "manual" },
        occurrence: { kind: "manual", requestId: randomUUID() },
      });
      enqueued++;
    } catch (err) {
      console.log(`  ! enqueue failed for doc=${documentId}: ${toMessage(err)}`);
    }
  }

  console.log(`  enqueued ${enqueued} triage runs (worker executes them)`);
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows(); // createRun resolves builtins from the in-process registry
  registerReplicachePokeAdapter(); // before the todo delete pokes

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
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close the queue so enqueued jobs are persisted before exit.
    await closeScriptResources(closeAgentQueue);
  });

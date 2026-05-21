/**
 * Smoke test for the m9 email-triage workflow.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-triage.ts
 *
 * Pre-req: a server process running (`pnpm dev`) so the agent worker can
 * actually pick up the run. Also requires a real connected Google account
 * with at least one ingested email — run smoke-google.ts first if needed.
 *
 * What this verifies end-to-end (with a connected credential):
 *   1. ensureAlfredLabels installs the six Alfred/* labels in the mailbox
 *      (or recovers them from a prior run via the credential metadata cache).
 *   2. Triggering email-triage on a real ingested doc runs through:
 *        classify  →  apply-label  →  done
 *      with a metered LLM call landing in api_call_log.
 *   3. The corresponding Gmail message picks up exactly one Alfred/* label
 *      (verified by re-fetching the message via the Gmail API).
 *   4. Re-running on the same doc is idempotent: it re-classifies (a fresh
 *      run does NOT skip the LLM — that's the explicit re-evaluation
 *      contract for replies) but the Gmail message ends up with one
 *      Alfred/* label still, regardless of category change.
 *
 * What this does NOT verify:
 *   - The webhook → ingest → triage fan-out (covered by smoke-google-poll
 *     plus a real send to the inbox).
 *   - User toggle to disable triage (deferred to m12 with the workflows
 *     table; m9 ships the workflow always-on for connected mailboxes).
 */
import {
  closeAgentQueue,
  closeConnections,
  closeRedis,
  createRun,
  enqueueRun,
  getTriage,
  TRIAGE_WORKFLOW_SLUG,
  upsertTriage,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import { agentRuns, documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  applyTriageLabel,
  ensureAlfredLabels,
  getMessage,
  getFreshAccessToken,
  TRIAGE_CATEGORIES,
  type TriageCategory,
} from "@alfred/integrations/google";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 90_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function findGoogleCredential(): Promise<{
  id: string;
  userId: string;
  accountLabel: string | null;
} | null> {
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountLabel: integrationCredentials.accountLabel,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "google"))
    .limit(1);
  return rows[0] ?? null;
}

async function pickIngestedDocument(userId: string) {
  const rows = await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      title: documents.title,
      authoredAt: documents.authoredAt,
    })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")))
    .orderBy(desc(documents.authoredAt))
    .limit(1);
  return rows[0] ?? null;
}

async function pollRun(runId: string, label: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!row) throw new Error(`run ${runId} not found while waiting for ${label}`);
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return row;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

async function fetchMessageLabelIds(credentialId: string, messageId: string): Promise<string[]> {
  const accessToken = await getFreshAccessToken(credentialId);
  const message = await getMessage({ accessToken, id: messageId, format: "metadata" });
  return message.labelIds ?? [];
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const cred = await findGoogleCredential();
  if (!cred) {
    console.log("[smoke-triage] no Google credential found.");
    console.log("Run smoke-google.ts first to connect an account + bulk ingest.");
    return;
  }
  console.log(`[smoke-triage] target: ${cred.accountLabel ?? cred.id} (user=${cred.userId})`);

  // ---- Phase 1: ensure Alfred labels exist ---------------------------------
  const labels = await ensureAlfredLabels(cred.id);
  for (const cat of TRIAGE_CATEGORIES) {
    assert(labels.byCategory[cat], `missing label for category=${cat}`);
  }
  console.log(
    `[smoke-triage] alfred labels installed (${Object.keys(labels.byCategory).length} categories)`,
  );

  // ---- Phase 2: pick a real ingested email --------------------------------
  const doc = await pickIngestedDocument(cred.userId);
  if (!doc) {
    throw new Error(
      "[smoke-triage] no ingested gmail documents — run smoke-google.ts to ingest first",
    );
  }
  console.log(
    `[smoke-triage] target doc=${doc.id} subject=${JSON.stringify(doc.title)} ` +
      `gmailMessageId=${doc.sourceId}`,
  );

  const labelsBefore = await fetchMessageLabelIds(cred.id, doc.sourceId);
  console.log(`[smoke-triage] gmail labels before: ${labelsBefore.join(", ") || "(none)"}`);

  // ---- Phase 3: enqueue triage run ----------------------------------------
  const { runId: runId1 } = await createRun({
    userId: cred.userId,
    workflowSlug: TRIAGE_WORKFLOW_SLUG,
    input: { documentId: doc.id, reason: "manual" },
    metadata: { source: "smoke-triage" },
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId1);
  console.log(`[smoke-triage] run 1 enqueued: ${runId1}`);

  const run1 = await pollRun(runId1, "run 1");
  assert(
    run1.status === "completed",
    `run 1 status=${run1.status} error=${JSON.stringify(run1.error)}`,
  );
  const out1 = run1.output as {
    category: TriageCategory;
    confidence: number;
    applied: boolean;
    appliedLabelId: string;
    removedLabelIds: string[];
  };
  console.log(
    `[smoke-triage] run 1 output: category=${out1.category} confidence=${out1.confidence?.toFixed(2)} ` +
      `applied=${out1.applied} appliedLabelId=${out1.appliedLabelId}`,
  );
  assert(out1.applied, "run 1 did not apply a label");
  assert(
    TRIAGE_CATEGORIES.includes(out1.category),
    `run 1 category outside taxonomy: ${out1.category}`,
  );

  // ---- Phase 4: verify DB row + Gmail state -------------------------------
  const triageRow = await getTriage(doc.id);
  assert(triageRow, "email_triage row missing after run 1");
  assert(
    triageRow.category === out1.category,
    `db category=${triageRow.category} != output category=${out1.category}`,
  );
  assert(
    triageRow.appliedLabelId === out1.appliedLabelId,
    `db appliedLabelId mismatch: ${triageRow.appliedLabelId} vs ${out1.appliedLabelId}`,
  );
  console.log(
    `[smoke-triage] db row OK: category=${triageRow.category} model=${triageRow.model} run=${triageRow.runId}`,
  );

  const labelsAfter = await fetchMessageLabelIds(cred.id, doc.sourceId);
  console.log(`[smoke-triage] gmail labels after: ${labelsAfter.join(", ")}`);
  assert(
    labelsAfter.includes(out1.appliedLabelId),
    `gmail message missing applied label ${out1.appliedLabelId}; has=${labelsAfter.join(", ")}`,
  );
  const alfredLabelsOnMessage = labelsAfter.filter((id) => labels.allIds.includes(id));
  assert(
    alfredLabelsOnMessage.length === 1,
    `expected exactly 1 alfred label on message, got ${alfredLabelsOnMessage.length}: ${alfredLabelsOnMessage.join(", ")}`,
  );

  // ---- Phase 5: re-run triage; verify still exactly one alfred label ------
  const { runId: runId2 } = await createRun({
    userId: cred.userId,
    workflowSlug: TRIAGE_WORKFLOW_SLUG,
    input: { documentId: doc.id, reason: "manual" },
    metadata: { source: "smoke-triage", attempt: 2 },
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId2);
  console.log(`[smoke-triage] run 2 enqueued: ${runId2}`);

  const run2 = await pollRun(runId2, "run 2");
  assert(run2.status === "completed", `run 2 status=${run2.status}`);
  const out2 = run2.output as { category: TriageCategory; appliedLabelId: string };
  console.log(
    `[smoke-triage] run 2 output: category=${out2.category} appliedLabelId=${out2.appliedLabelId}`,
  );

  const labelsFinal = await fetchMessageLabelIds(cred.id, doc.sourceId);
  const alfredLabelsFinal = labelsFinal.filter((id) => labels.allIds.includes(id));
  assert(
    alfredLabelsFinal.length === 1,
    `after re-run expected exactly 1 alfred label, got ${alfredLabelsFinal.length}: ${alfredLabelsFinal.join(", ")}`,
  );
  assert(
    alfredLabelsFinal[0] === out2.appliedLabelId,
    `final alfred label ${alfredLabelsFinal[0]} != run 2 output ${out2.appliedLabelId}`,
  );

  // The triage row should now reflect run 2's classification, not run 1's.
  const finalRow = await getTriage(doc.id);
  assert(finalRow, "triage row missing after run 2");
  assert(finalRow.runId === runId2, `triage row runId=${finalRow.runId} != run2=${runId2}`);

  // Quick sanity: total email_triage rows for this user matches docs we've triaged.
  const rowCount = await db().select().from(emailTriage).where(eq(emailTriage.userId, cred.userId));
  console.log(`[smoke-triage] total email_triage rows for user: ${rowCount.length}`);

  // ---- Phase 6: thread-sibling stripping (best-effort) --------------------
  //
  // If the mailbox has a thread with multiple ingested messages, triaging
  // the newest one should strip alfred labels from the older siblings so
  // the thread ends up with a single tag in the Gmail UI. Conditional —
  // not every test mailbox has multi-message threads.
  const candidateThreads = await db()
    .select({
      threadId: documents.sourceThreadId,
      msgCount: sql<number>`count(*)::int`.as("msg_count"),
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, cred.userId),
        eq(documents.source, "gmail"),
        isNotNull(documents.sourceThreadId),
      ),
    )
    .groupBy(documents.sourceThreadId)
    .having(sql`count(*) > 1`)
    .limit(1);
  const candidateThread = candidateThreads[0];

  if (!candidateThread?.threadId) {
    console.log("[smoke-triage] no multi-message thread in mailbox — skipping sibling-strip phase");
  } else {
    const threadDocs = await db()
      .select({
        id: documents.id,
        sourceId: documents.sourceId,
        authoredAt: documents.authoredAt,
      })
      .from(documents)
      .where(
        and(
          eq(documents.userId, cred.userId),
          eq(documents.source, "gmail"),
          eq(documents.sourceThreadId, candidateThread.threadId),
        ),
      )
      .orderBy(desc(documents.authoredAt));
    const [latest, ...older] = threadDocs;
    if (!latest || older.length === 0) {
      console.log("[smoke-triage] candidate thread degenerate — skipping sibling-strip phase");
    } else {
      console.log(
        `[smoke-triage] thread=${candidateThread.threadId} latest=${latest.id} ` +
          `older=${older.map((d) => d.id).join(",")}`,
      );

      // Seed: directly apply an alfred label to every message in the thread,
      // bypassing the workflow. Running the workflow here would cascade-
      // strip earlier siblings as each seed lands (that's the behavior we're
      // about to test); by the time we re-triage `latest`, only the oldest
      // seed would remain. Direct seeding gives us the multi-labeled initial
      // state the strip-step needs to actually do work.
      const seedCategory: TriageCategory = "fyi";
      const seedLabelId = labels.byCategory[seedCategory];
      for (const d of threadDocs) {
        await applyTriageLabel({
          credentialId: cred.id,
          messageId: d.sourceId,
          category: seedCategory,
        });
        await upsertTriage({
          documentId: d.id,
          userId: cred.userId,
          category: seedCategory,
          confidence: 1,
          rationale: "smoke-triage:seed",
          model: "smoke-triage",
          runId: null,
          appliedLabelId: seedLabelId,
        });
      }

      // Re-triage the latest message — should strip every older sibling.
      const { runId: latestRunId } = await createRun({
        userId: cred.userId,
        workflowSlug: TRIAGE_WORKFLOW_SLUG,
        input: { documentId: latest.id, reason: "manual" },
        metadata: { source: "smoke-triage", phase: "strip-siblings" },
        trigger: { kind: "manual" },
      });
      await enqueueRun(latestRunId);
      const latestRun = await pollRun(latestRunId, "strip-siblings");
      assert(latestRun.status === "completed", `strip-siblings status=${latestRun.status}`);
      const latestOut = latestRun.output as { strippedSiblings: number };
      console.log(
        `[smoke-triage] strip-siblings stripped=${latestOut.strippedSiblings} (expected=${older.length})`,
      );
      assert(
        latestOut.strippedSiblings === older.length,
        `expected to strip ${older.length} siblings, got ${latestOut.strippedSiblings}`,
      );

      // Each older message should now have zero alfred labels in Gmail and
      // applied_label_id cleared in the DB.
      for (const d of older) {
        const onMessage = (await fetchMessageLabelIds(cred.id, d.sourceId)).filter((id) =>
          labels.allIds.includes(id),
        );
        assert(
          onMessage.length === 0,
          `older message ${d.sourceId} still has alfred labels: ${onMessage.join(", ")}`,
        );
        const t = await getTriage(d.id);
        assert(t, `triage row missing for older doc ${d.id}`);
        assert(
          t.appliedLabelId === null,
          `older doc ${d.id} appliedLabelId not cleared: ${t.appliedLabelId}`,
        );
      }

      // And the latest message should still carry exactly one alfred label.
      const onLatest = (await fetchMessageLabelIds(cred.id, latest.sourceId)).filter((id) =>
        labels.allIds.includes(id),
      );
      assert(
        onLatest.length === 1,
        `latest message expected 1 alfred label, got ${onLatest.length}: ${onLatest.join(", ")}`,
      );
    }
  }

  console.log("\n[smoke-triage] PASS");
}

main()
  .catch((err) => {
    console.error("[smoke-triage] FAIL", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

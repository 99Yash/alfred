/**
 * Smoke test for the m8b memory-extraction workflow.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-extract.ts
 *
 * Pre-req: a server process running (`pnpm dev`) — its agent + memory
 * workers are what actually drive the run.
 *
 * What we exercise:
 *   1. Plant a fake `documents` row owned by a smoke user.
 *   2. Trigger the workflow in `manual` mode with pre-baked proposals
 *      keyed by that doc id (no LLM tokens burned).
 *   3. Poll the run to completion.
 *   4. Assert: proposed facts landed, `memory_extraction_status` row
 *      written, `memory_chunks` summary present.
 *   5. Trigger again — second run is a no-op (proposeFact dedups, doc
 *      sits inside the extracted-window) and produces the same output.
 */
import { closeAgentQueue, closeConnections, closeRedis, warmPool } from "@alfred/api";
import { enqueueExtractionForUser } from "@alfred/api";
import { recallActiveByKey } from "@alfred/api";
import { registerBuiltinWorkflows } from "../../builtins";
import { db } from "@alfred/db";
import {
  agentRuns,
  documents,
  memoryChunks,
  memoryExtractionStatus,
  user as userTable,
} from "@alfred/db/schemas";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 60_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function findOrCreateSmokeUser(): Promise<string> {
  const email = "smoke-extract@alfred.local";
  const existing = await db().select().from(userTable).where(eq(userTable.email, email));
  if (existing[0]) return existing[0].id;
  const inserted = await db()
    .insert(userTable)
    .values({ name: "Smoke Extract", email, emailVerified: true })
    .returning({ id: userTable.id });
  return inserted[0]!.id;
}

async function plantDocument(userId: string, runTag: string) {
  // Idempotent on (user, source, source_id): re-running the smoke
  // returns the same row id.
  const sourceId = `smoke-extract-${runTag}`;
  const content = [
    "From: alice@acme.test",
    "To: me@example.com",
    "Subject: re: budget review",
    "",
    "Hey — yes, let's catch up Thursday at 3pm. As your manager I want to make sure",
    "we have a clear picture of Q3 spend before the leadership review next week.",
    "",
    "— Alice",
  ].join("\n");
  const contentHash = createHash("sha256").update(content).digest("hex");

  const [row] = await db()
    .insert(documents)
    .values({
      userId,
      source: "gmail",
      sourceId,
      title: "re: budget review",
      content,
      contentHash,
      authoredAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [documents.userId, documents.source, documents.sourceId],
      set: { contentHash },
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("failed to plant smoke document");
  return row.id;
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

async function main() {
  await warmPool();
  // Local registration so createRun's `requireWorkflow` can build the
  // initial state — the server process has its own registration.
  registerBuiltinWorkflows();
  const userId = await findOrCreateSmokeUser();
  const runTag = Math.random().toString(36).slice(2, 8);
  const docId = await plantDocument(userId, runTag);
  console.log(`[smoke-extract] userId=${userId} docId=${docId} runTag=${runTag}`);

  // Use uniquely-keyed facts so reruns don't collide with prior runs'
  // active rows in user_facts (proposeFact's dup guard would block the
  // identical (key, value) on round two).
  const proposals = [
    {
      key: `smoke:manager:${runTag}`,
      value: { name: "Alice", email: "alice@acme.test" },
      confidence: 0.92,
      rationale: "Email signed 'as your manager'.",
    },
    {
      key: `smoke:company:${runTag}`,
      value: "Acme",
      confidence: 0.82,
      rationale: "Sender domain is acme.test.",
    },
  ];

  // ---------------------------------------------------------------------
  // Run 1 — should propose both facts, write status row + memory_chunk.
  // ---------------------------------------------------------------------
  const { runId: runId1 } = await enqueueExtractionForUser(userId, {
    mode: "manual",
    manualProposals: { [docId]: proposals },
    sinceDays: 30,
    maxDocs: 5,
  });
  console.log(`[smoke-extract] run 1 enqueued: ${runId1}`);

  const run1 = await pollRun(runId1, "run 1 completion");
  assert(run1.status === "completed", `run 1 status=${run1.status}`);
  const out1 = run1.output as { processed: number; proposed: number; blocked: number };
  console.log(
    `[smoke-extract] run 1 output: processed=${out1.processed} proposed=${out1.proposed} blocked=${out1.blocked}`,
  );
  assert(out1.processed === 1, `expected processed=1, got ${out1.processed}`);
  assert(out1.proposed === 2, `expected proposed=2, got ${out1.proposed}`);
  assert(out1.blocked === 0, `expected blocked=0 on first run, got ${out1.blocked}`);

  // Facts landed
  const managerFacts = await recallActiveByKey(userId, `smoke:manager:${runTag}`, {
    includeProposed: true,
  });
  assert(managerFacts.length === 1, `expected 1 manager fact, got ${managerFacts.length}`);
  assert(managerFacts[0]!.confidence > 0.9, "manager confidence should match proposal");

  // Status row landed
  const [statusRow] = await db()
    .select()
    .from(memoryExtractionStatus)
    .where(eq(memoryExtractionStatus.documentId, docId));
  assert(statusRow, "memory_extraction_status row missing");
  assert(statusRow.lastRunId === runId1, `lastRunId mismatch`);
  assert(statusRow.proposedCount === 2, `proposedCount mismatch ${statusRow.proposedCount}`);

  // Summary memory_chunk landed
  const summaryChunks = await db()
    .select()
    .from(memoryChunks)
    .where(and(eq(memoryChunks.userId, userId), eq(memoryChunks.kind, "extraction_run")))
    .orderBy(desc(memoryChunks.createdAt))
    .limit(1);
  assert(summaryChunks[0], "extraction_run memory_chunk missing");
  assert(
    summaryChunks[0].content.includes(runId1),
    `summary should reference run id, got: ${summaryChunks[0].content}`,
  );

  console.log("[smoke-extract] run 1 assertions OK");

  // ---------------------------------------------------------------------
  // Run 2 — same proposals; both should be blocked by dedup, but the
  // workflow itself still processes (manual mode bypasses the freshness
  // window). Status row's lastRunId moves to runId2.
  // ---------------------------------------------------------------------
  const { runId: runId2 } = await enqueueExtractionForUser(userId, {
    mode: "manual",
    manualProposals: { [docId]: proposals },
    sinceDays: 30,
    maxDocs: 5,
  });
  console.log(`[smoke-extract] run 2 enqueued: ${runId2}`);

  const run2 = await pollRun(runId2, "run 2 completion");
  assert(run2.status === "completed", `run 2 status=${run2.status}`);
  const out2 = run2.output as { processed: number; proposed: number; blocked: number };
  console.log(
    `[smoke-extract] run 2 output: processed=${out2.processed} proposed=${out2.proposed} blocked=${out2.blocked}`,
  );
  assert(out2.processed === 1, `expected processed=1, got ${out2.processed}`);
  assert(out2.proposed === 0, `expected proposed=0 on dup run, got ${out2.proposed}`);
  assert(out2.blocked === 2, `expected blocked=2 on dup run, got ${out2.blocked}`);

  // Confirm no duplicate facts piled up
  const stillOne = await recallActiveByKey(userId, `smoke:manager:${runTag}`, {
    includeProposed: true,
  });
  assert(stillOne.length === 1, `dup guard failed — got ${stillOne.length} active rows`);

  console.log("\n[smoke-extract] PASS");
}

main()
  .catch((err) => {
    console.error("[smoke-extract] FAIL", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

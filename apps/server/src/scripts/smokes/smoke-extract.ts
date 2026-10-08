/**
 * Smoke test for the memory-extraction workflow with pre-baked proposals (no
 * model calls). The first run writes facts, a status row, and a summary chunk.
 * The second run adds no duplicate facts.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-extract.ts
 *
 * Pre-req: a server process running (`pnpm dev`).
 */
import { closeAgentQueue } from "@alfred/assistant/execution";
import { getPath } from "@alfred/contracts";
import { warmPool } from "@alfred/db";
import { enqueueExtractionForUser } from "@alfred/assistant/knowledge/queue";
import { memoryExtractionOutcomeSchema, recallActiveByKey } from "@alfred/assistant/knowledge";
import { registerBuiltinWorkflows } from "~/builtins";
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
import { closeScriptResources } from "../script-runtime";

const POLL_INTERVAL_MS = 250;

const POLL_TIMEOUT_MS = 60_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function readRunOutcome(output: unknown, label: string) {
  const parsed = memoryExtractionOutcomeSchema.safeParse(getPath(output, "outcome"));

  if (!parsed.success) {
    throw new Error(`assertion failed: ${label} output carries no valid outcome`);
  }

  return parsed.data;
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
  // Idempotent on (user, source, source_id).
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
  // So `requireWorkflow` can build the initial state in this process.
  registerBuiltinWorkflows();
  const userId = await findOrCreateSmokeUser();
  const runTag = Math.random().toString(36).slice(2, 8);
  const docId = await plantDocument(userId, runTag);
  console.log(`[smoke-extract] userId=${userId} docId=${docId} runTag=${runTag}`);

  // Per-run keys, so proposeFact's dup guard does not block a rerun.
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

  // Run 1.
  const { runId: runId1 } = await enqueueExtractionForUser(userId, {
    mode: "manual",
    manualProposals: { [docId]: proposals },
    sinceDays: 30,
    maxDocs: 5,
  });

  console.log(`[smoke-extract] run 1 enqueued: ${runId1}`);

  const run1 = await pollRun(runId1, "run 1 completion");
  assert(run1.status === "completed", `run 1 status=${run1.status}`);
  // The parse also asserts the `facts_proposed` discriminant.
  const out1 = readRunOutcome(run1.output, "run 1");
  console.log(`[smoke-extract] run 1 outcome: ${JSON.stringify(out1)}`);
  assert(out1.kind === "facts_proposed", `expected facts_proposed, got ${out1.kind}`);
  assert(out1.picked === 1, `expected picked=1, got ${out1.picked}`);
  assert(out1.processed === 1, `expected processed=1, got ${out1.processed}`);
  assert(out1.proposed === 2, `expected proposed=2, got ${out1.proposed}`);
  assert(out1.blocked === 0, `expected blocked=0 on first run, got ${out1.blocked}`);

  const managerFacts = await recallActiveByKey(userId, `smoke:manager:${runTag}`, {
    includeProposed: true,
  });

  assert(managerFacts.length === 1, `expected 1 manager fact, got ${managerFacts.length}`);
  assert(managerFacts[0]!.confidence > 0.9, "manager confidence should match proposal");

  const [statusRow] = await db()
    .select()
    .from(memoryExtractionStatus)
    .where(eq(memoryExtractionStatus.documentId, docId));

  assert(statusRow, "memory_extraction_status row missing");
  assert(statusRow.lastRunId === runId1, `lastRunId mismatch`);
  assert(statusRow.proposedCount === 2, `proposedCount mismatch ${statusRow.proposedCount}`);

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

  // Run 2: dedup blocks both facts, but manual mode still runs the workflow.
  const { runId: runId2 } = await enqueueExtractionForUser(userId, {
    mode: "manual",
    manualProposals: { [docId]: proposals },
    sinceDays: 30,
    maxDocs: 5,
  });

  console.log(`[smoke-extract] run 2 enqueued: ${runId2}`);

  const run2 = await pollRun(runId2, "run 2 completion");
  assert(run2.status === "completed", `run 2 status=${run2.status}`);
  const out2 = readRunOutcome(run2.output, "run 2");
  console.log(`[smoke-extract] run 2 outcome: ${JSON.stringify(out2)}`);
  assert(out2.kind === "no_facts_proposed", `expected no_facts_proposed, got ${out2.kind}`);
  assert(out2.picked === 1, `expected picked=1, got ${out2.picked}`);
  assert(out2.processed === 1, `expected processed=1, got ${out2.processed}`);
  assert(out2.blocked === 2, `expected blocked=2 on dup run, got ${out2.blocked}`);

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
    await closeScriptResources(closeAgentQueue);
  });

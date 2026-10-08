/**
 * Smoke test for the cold-start-research workflow: the run completes, and its
 * `memory_chunks` row and `cold_start` facts land for the user.
 * It does not check the OAuth-callback trigger or the research quality.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-cold-start.ts
 *
 * Pre-reqs:
 *   - A server process running (`pnpm dev`).
 *   - `GOOGLE_GENERATIVE_AI_API_KEY` for the seed, synthesis, and `web_search` loops.
 *   - A user row, ideally with a connected Google credential.
 */
import { randomUUID } from "node:crypto";
import { COLD_START_WORKFLOW_SLUG } from "@alfred/assistant/knowledge";
import { startRun, closeAgentQueue } from "@alfred/assistant/execution";
import { warmPool } from "@alfred/db";
import { db } from "@alfred/db";
import { agentRuns, memoryChunks, user as userTable, userFacts } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const POLL_INTERVAL_MS = 1_000;

const POLL_TIMEOUT_MS = 5 * 60_000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function pickUser() {
  const rows = await db()
    .select({ id: userTable.id, email: userTable.email, name: userTable.name })
    .from(userTable)
    .limit(1);

  return rows[0] ?? null;
}

async function pollRun(runId: string, label: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStep: string | null = null;

  while (Date.now() < deadline) {
    const [row] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));

    if (!row) throw new Error(`run ${runId} not found while waiting for ${label}`);

    if (row.currentStep !== lastStep) {
      console.log(`[smoke-cold-start]   step → ${row.currentStep} (status=${row.status})`);
      lastStep = row.currentStep;
    }

    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return row;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

async function fetchMemoryChunkById(id: string, userId: string) {
  const rows = await db()
    .select()
    .from(memoryChunks)
    .where(and(eq(memoryChunks.id, id), eq(memoryChunks.userId, userId)));

  return rows[0] ?? null;
}

async function fetchColdStartFacts(userId: string, runId: string) {
  // Only facts from this run.
  return db()
    .select({
      id: userFacts.id,
      key: userFacts.key,
      value: userFacts.value,
      confidence: userFacts.confidence,
      status: userFacts.status,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, userId),
        sql`${userFacts.source}->>'kind' = 'cold_start'`,
        sql`${userFacts.source}->>'id' = ${runId}`,
      ),
    )
    .orderBy(desc(userFacts.confidence));
}

async function main() {
  if (!serverEnv().GOOGLE_GENERATIVE_AI_API_KEY) {
    console.log(
      "[smoke-cold-start] GOOGLE_GENERATIVE_AI_API_KEY not set — the seed/synthesis boss calls and grounded web_search loops will fail. Set it in apps/server/.env first.",
    );

    return;
  }

  await warmPool();
  registerBuiltinWorkflows();

  const u = await pickUser();

  if (!u) {
    console.log("[smoke-cold-start] no user rows — sign in first.");

    return;
  }

  console.log(`[smoke-cold-start] target: ${u.email} (id=${u.id})`);

  // One active cold-start run per user (unique on `dedup_key`). Cancel the old one.
  const stomped = await db()
    .update(agentRuns)
    .set({ status: "cancelled", endedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, u.id),
        eq(agentRuns.workflowSlug, COLD_START_WORKFLOW_SLUG),
        sql`${agentRuns.status} NOT IN ('failed', 'cancelled')`,
      ),
    )
    .returning({ id: agentRuns.id });

  if (stomped.length) {
    console.log(
      `[smoke-cold-start] cancelled ${stomped.length} prior run(s) to clear the dedup index.`,
    );
  }

  const { runId } = await startRun({
    userId: u.id,
    workflowSlug: COLD_START_WORKFLOW_SLUG,
    input: { reason: "manual" },
    trigger: { kind: "manual" },
    occurrence: { kind: "manual", requestId: randomUUID() },
  });

  console.log(`[smoke-cold-start] run enqueued: ${runId}`);

  const run = await pollRun(runId, "cold-start run");
  assert(run.status === "completed", `run status=${run.status} error=${JSON.stringify(run.error)}`);

  // SAFETY: the cold-start workflow's own output shape.
  const out = run.output as {
    factsProposed: number;
    factsSkipped: number;
    memoryChunkId: string;
    citationCount: number;
  };

  console.log(
    `[smoke-cold-start] output: factsProposed=${out.factsProposed} ` +
      `factsSkipped=${out.factsSkipped} citationCount=${out.citationCount} ` +
      `memoryChunkId=${out.memoryChunkId}`,
  );
  assert(out.memoryChunkId, "expected output.memoryChunkId");
  assert(out.factsProposed >= 0, "expected output.factsProposed >= 0");
  assert(out.citationCount >= 0, "expected output.citationCount >= 0");

  const chunk = await fetchMemoryChunkById(out.memoryChunkId, u.id);
  assert(chunk, `memory_chunks row ${out.memoryChunkId} not found`);
  assert(chunk.kind === "cold_start_research", `unexpected chunk.kind=${chunk.kind}`);
  console.log(
    `[smoke-cold-start] memory chunk: ${chunk.content.length} chars, ` +
      `embedding=${chunk.embedding ? "set" : "pending sweep"}`,
  );

  const facts = await fetchColdStartFacts(u.id, runId);
  console.log(`[smoke-cold-start] fact rows from this run: ${facts.length}`);

  for (const f of facts.slice(0, 10)) {
    console.log(
      `  - ${f.key} = ${JSON.stringify(f.value)}  ` +
        `(conf=${f.confidence.toFixed(2)} status=${f.status})`,
    );
  }

  console.log("\n[smoke-cold-start] PASS");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-cold-start] FAIL",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources(closeAgentQueue);
  });

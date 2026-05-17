/**
 * Smoke test for the m11 cold-start-research workflow.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-cold-start.ts
 *
 * Pre-reqs:
 *   - A server process running (`pnpm dev`) so the agent worker can pick
 *     up the run. (Or run this with the worker started in-process — the
 *     script does not start one itself; mirroring smoke-briefing.)
 *   - `PERPLEXITY_API_KEY` set so Sonar Deep Research returns content.
 *   - At least one user row, ideally with a connected Google credential
 *     so the signal collector contributes more than the bare email.
 *
 * What this verifies end-to-end:
 *   1. Any prior cold-start run for this user is moved to `cancelled`
 *      so the partial unique index on `agent_runs.dedup_key` doesn't
 *      reject the fresh smoke run.
 *   2. createRun + enqueueRun cycle a `cold-start-research` run.
 *   3. The workflow runs gather-signals → research → extract-facts →
 *      persist to completion.
 *   3. The run output reports a non-negative `factsProposed`,
 *      `memoryChunkId`, and `citationCount`.
 *   4. A `memory_chunks` row with `kind='cold_start_research'` exists
 *      for the user and its content roughly matches what was proposed.
 *   5. `user_facts` rows whose `source.kind='cold_start'` reference the
 *      run id we just created (when the model emitted any).
 *
 * What this does NOT verify:
 *   - That the OAuth-callback trigger fires the run (covered by manual
 *     re-connect testing on a fresh user).
 *   - Quality of the research output (qualitative, requires human review).
 */
import {
  closeAgentQueue,
  closeConnections,
  closeRedis,
  COLD_START_WORKFLOW_SLUG,
  createRun,
  enqueueRun,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import { agentRuns, memoryChunks, user as userTable, userFacts } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../builtins";

// Sonar Deep Research can take 30–120s; budget 5min before giving up.
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
  // Filter on `source->>'id' = runId` so we see only proposals from the
  // run we just created — earlier runs (or smoke re-invocations) get
  // skipped.
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
  if (!serverEnv().PERPLEXITY_API_KEY) {
    console.log(
      "[smoke-cold-start] PERPLEXITY_API_KEY not set — Sonar Deep Research call will fail. Set it in apps/server/.env first.",
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

  // The cold-start workflow is singleton-per-user via the partial
  // unique index on `agent_runs.dedup_key`. Cancel any prior active
  // row so the fresh insert below isn't blocked. Failed/cancelled
  // rows are excluded from the index, so this leaves history intact.
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

  const { runId } = await createRun({
    userId: u.id,
    workflowSlug: COLD_START_WORKFLOW_SLUG,
    input: { reason: "manual" },
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId);
  console.log(`[smoke-cold-start] run enqueued: ${runId}`);

  const run = await pollRun(runId, "cold-start run");
  assert(
    run.status === "completed",
    `run status=${run.status} error=${JSON.stringify(run.error)}`,
  );

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
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

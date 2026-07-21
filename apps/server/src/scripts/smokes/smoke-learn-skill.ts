/**
 * Smoke test for the m12 learn-skill workflow.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-learn-skill.ts
 *
 * Pre-reqs:
 *   - A server process running (`pnpm dev`) so the agent worker picks up
 *     the run. The script does not start an in-process worker.
 *   - At least one user row in the DB (sign in once first).
 *   - A cheap-tier model available — depending on @alfred/ai's resolver
 *     that's either ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.
 *
 * What this verifies end-to-end:
 *   1. A draft `skills` row is created (mirroring the UX where clicking
 *      "New skill" inserts the placeholder before Learn fires).
 *   2. Any prior in-flight learn-skill run for that skill is moved to
 *      `cancelled` so the partial unique index on
 *      `agent_runs.(user_id, workflow_slug, dedup_key)` doesn't reject
 *      the fresh smoke insert.
 *   3. createRun + enqueueRun cycle a `learn-skill` run.
 *   4. The workflow runs gather → distill → persist to completion.
 *   5. The skill row advances: `status='active'`, `current_revision_id`
 *      points at the new `skill_revisions` row, `name` reflects the
 *      LLM-suggested title.
 *   6. A `skill_runs` row exists, in `completed` status, pointing at the
 *      same revision id.
 *   7. `user_facts` rows whose `source.id = runId` exist (when the model
 *      emitted any proposals — single-string keys per the distill schema).
 */
import { createRun, enqueueRun, LEARN_SKILL_WORKFLOW_SLUG } from "@alfred/api/backend";
import { closeAgentQueue, warmPool } from "@alfred/api/runtime";
import { db } from "@alfred/db";
import {
  agentRuns,
  skillRevisions,
  skillRuns,
  skills,
  user as userTable,
  userFacts,
} from "@alfred/db/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "~/builtins";
import { closeScriptResources } from "../script-runtime";

const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 90_000; // cheap-tier distill is ~5–15s; 90s is comfortable headroom.

const SAMPLE_PROMPT =
  "i am looking for remote engineering jobs with $40k+ minimum salary. " +
  "i prefer early-stage startups working with react, typescript, and ai. " +
  "draft cold emails with lowercase subject lines that open with a compliment about the company.";

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
      console.log(`[smoke-learn-skill]   step → ${row.currentStep} (status=${row.status})`);
      lastStep = row.currentStep;
    }
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      return row;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${label} on run ${runId}`);
}

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const u = await pickUser();
  if (!u) {
    console.log("[smoke-learn-skill] no user rows — sign in first.");
    return;
  }
  console.log(`[smoke-learn-skill] target: ${u.email} (id=${u.id})`);

  // Ensure a stable test-only skill row exists. We key on a fixed slug
  // so re-running the smoke doesn't accumulate skills. The row is left
  // in `draft` until the first Learn run completes.
  const testSlug = "smoke-learn-skill";
  const [existing] = await db()
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, u.id), eq(skills.slug, testSlug)))
    .limit(1);

  let skillId: string;
  if (existing) {
    skillId = existing.id;
    // Reset to draft + clear the revision pointer so we can re-verify
    // the draft → active transition on each smoke run.
    await db()
      .update(skills)
      .set({
        status: "draft",
        currentRevisionId: null,
        name: "Untitled skill",
      })
      .where(eq(skills.id, skillId));
    console.log(`[smoke-learn-skill] reset existing skill ${skillId} to draft`);
  } else {
    const [row] = await db()
      .insert(skills)
      .values({
        userId: u.id,
        slug: testSlug,
        name: "Untitled skill",
        status: "draft",
      })
      .returning({ id: skills.id });
    if (!row) throw new Error("failed to insert smoke skill");
    skillId = row.id;
    console.log(`[smoke-learn-skill] created skill ${skillId}`);
  }

  // Clear any in-flight learn-skill rows for THIS skill so the per-skill
  // dedup index doesn't block the fresh insert. Failed/cancelled rows
  // are excluded from the index already, so nothing is overwritten.
  const stomped = await db()
    .update(agentRuns)
    .set({ status: "cancelled", endedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, u.id),
        eq(agentRuns.workflowSlug, LEARN_SKILL_WORKFLOW_SLUG),
        eq(agentRuns.dedupKey, `learn-skill:${skillId}`),
        sql`${agentRuns.status} NOT IN ('failed', 'cancelled')`,
      ),
    )
    .returning({ id: agentRuns.id });
  if (stomped.length) {
    console.log(
      `[smoke-learn-skill] cancelled ${stomped.length} prior run(s) to clear the dedup index.`,
    );
  }

  const { runId } = await createRun({
    userId: u.id,
    workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
    input: { skillId, prompt: SAMPLE_PROMPT, reason: "manual" },
    trigger: { kind: "manual" },
  });
  await enqueueRun(runId);
  console.log(`[smoke-learn-skill] run enqueued: ${runId}`);

  const run = await pollRun(runId, "learn-skill run");
  assert(run.status === "completed", `run status=${run.status} error=${JSON.stringify(run.error)}`);

  const out = run.output as {
    skillId: string;
    revisionId: string;
    skillStatus: string;
    factsProposed: number;
    factsSkipped: number;
    mentionCount: number;
  };
  console.log(
    `[smoke-learn-skill] output: revisionId=${out.revisionId} status=${out.skillStatus} ` +
      `facts=${out.factsProposed}/${out.factsProposed + out.factsSkipped} mentions=${out.mentionCount}`,
  );
  assert(out.revisionId, "expected output.revisionId");
  assert(out.skillId === skillId, "output.skillId mismatch");

  // Skill row state assertions.
  const [postSkill] = await db().select().from(skills).where(eq(skills.id, skillId));
  assert(postSkill, "skill row missing after run");
  console.log(
    `[smoke-learn-skill] skill: name="${postSkill.name}" status=${postSkill.status} ` +
      `currentRevisionId=${postSkill.currentRevisionId}`,
  );
  assert(postSkill.status === "active", `expected status=active, got ${postSkill.status}`);
  assert(
    postSkill.currentRevisionId === out.revisionId,
    `current_revision_id mismatch: ${postSkill.currentRevisionId} vs ${out.revisionId}`,
  );
  assert(postSkill.name !== "Untitled skill", "expected name to be auto-updated by distill");

  // Revision row.
  const [rev] = await db()
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.id, out.revisionId));
  assert(rev, "skill_revisions row missing");
  assert(rev.kind === "distilled", `expected revision kind=distilled, got ${rev.kind}`);
  assert(rev.body.length > 0, "expected non-empty body");
  console.log(`[smoke-learn-skill] revision body preview:\n${rev.body.slice(0, 400)}\n...`);

  // Skill-run row.
  const [sr] = await db().select().from(skillRuns).where(eq(skillRuns.agentRunId, runId));
  assert(sr, "skill_runs row missing");
  assert(sr.status === "completed", `skill_runs.status = ${sr.status}`);
  assert(
    sr.producedRevisionId === out.revisionId,
    `skill_runs.produced_revision_id mismatch: ${sr.producedRevisionId} vs ${out.revisionId}`,
  );

  // Fact proposals attributable to this run.
  const facts = await db()
    .select({
      key: userFacts.key,
      value: userFacts.value,
      confidence: userFacts.confidence,
      status: userFacts.status,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, u.id),
        sql`${userFacts.source}->'meta'->>'workflow' = ${LEARN_SKILL_WORKFLOW_SLUG}`,
        sql`${userFacts.source}->>'id' = ${runId}`,
      ),
    )
    .orderBy(desc(userFacts.confidence));
  console.log(`[smoke-learn-skill] fact rows from this run: ${facts.length}`);
  assert(
    facts.length === out.factsProposed,
    `fact rows (${facts.length}) does not match output.factsProposed (${out.factsProposed})`,
  );
  for (const f of facts.slice(0, 10)) {
    console.log(
      `  - ${f.key} = ${JSON.stringify(f.value)}  ` +
        `(conf=${f.confidence.toFixed(2)} status=${f.status})`,
    );
  }

  console.log("\n[smoke-learn-skill] PASS");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-learn-skill] FAIL",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources(closeAgentQueue);
  });

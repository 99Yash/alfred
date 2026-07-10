/**
 * Smoke test for the m12c skill-documentation workflow.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smokes/smoke-skill-documentation.ts
 *
 * Pre-reqs:
 *   - `pnpm dev` running so the agent worker picks up both workflows.
 *   - At least one user row.
 *   - A boss-tier model available (ANTHROPIC_API_KEY) — compose runs at
 *     boss tier per ADR. Tens of cents per smoke run.
 *   - Resend env vars (RESEND_API_KEY, RESEND_FROM_EMAIL); the smoke
 *     does NOT skip the email send. To suppress real delivery, point
 *     RESEND_FROM_EMAIL at a sandbox address.
 *
 * What this verifies:
 *   1. Driving learn-skill end-to-end (smoke-learn-skill territory).
 *   2. learn-skill's persist step auto-enqueues skill-documentation.
 *   3. skill-documentation runs gather-context → compose → persist-revision
 *      → notify to completion.
 *   4. A new `skill_revisions` row with kind='documented' lands and
 *      `skills.current_revision_id` advances to it.
 *   5. An `email_sends` row with kind='skill_documented' exists for
 *      the user, idempotency-keyed on the v2 revision id.
 *   6. The v2 revision row's metadata carries source counts and the
 *      previous (v1) revision id pointer.
 */
import {
  createRun,
  enqueueRun,
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
} from "@alfred/api/backend";
import { closeAgentQueue, closeConnections, closeRedis, warmPool } from "@alfred/api/runtime";
import { toRecord } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  agentRuns,
  emailSends,
  skillRevisions,
  skillRuns,
  skills,
  user as userTable,
} from "@alfred/db/schemas";
import { and, desc, eq, sql } from "drizzle-orm";
import { registerBuiltinWorkflows } from "../../builtins";

const POLL_INTERVAL_MS = 1_000;
const LEARN_TIMEOUT_MS = 90_000;
const DOC_TIMEOUT_MS = 5 * 60_000;

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

async function pollRun(runId: string, label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastStep: string | null = null;
  while (Date.now() < deadline) {
    const [row] = await db().select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!row) throw new Error(`run ${runId} not found while waiting for ${label}`);
    if (row.currentStep !== lastStep) {
      console.log(`[smoke-skill-doc]   ${label} → ${row.currentStep} (status=${row.status})`);
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
    console.log("[smoke-skill-doc] no user rows — sign in first.");
    return;
  }
  console.log(`[smoke-skill-doc] target: ${u.email} (id=${u.id})`);

  const testSlug = "smoke-skill-doc";
  const [existing] = await db()
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, u.id), eq(skills.slug, testSlug)))
    .limit(1);

  let skillId: string;
  if (existing) {
    skillId = existing.id;
    await db()
      .update(skills)
      .set({ status: "draft", currentRevisionId: null, name: "Untitled skill" })
      .where(eq(skills.id, skillId));
    console.log(`[smoke-skill-doc] reset existing skill ${skillId} to draft`);
  } else {
    const [row] = await db()
      .insert(skills)
      .values({ userId: u.id, slug: testSlug, name: "Untitled skill", status: "draft" })
      .returning({ id: skills.id });
    if (!row) throw new Error("failed to insert smoke skill");
    skillId = row.id;
    console.log(`[smoke-skill-doc] created skill ${skillId}`);
  }

  // Cancel any prior in-flight learn or doc runs for this skill so the
  // partial unique indexes don't reject our fresh inserts.
  const dedupKeysBySlug: Array<[string, string]> = [
    [LEARN_SKILL_WORKFLOW_SLUG, learnSkillDedupKey(skillId)],
    [SKILL_DOCUMENTATION_WORKFLOW_SLUG, skillDocumentationDedupKey(skillId)],
  ];
  for (const [slug, dedupKey] of dedupKeysBySlug) {
    const stomped = await db()
      .update(agentRuns)
      .set({ status: "cancelled", endedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(agentRuns.userId, u.id),
          eq(agentRuns.workflowSlug, slug),
          eq(agentRuns.dedupKey, dedupKey),
          sql`${agentRuns.status} NOT IN ('failed', 'cancelled')`,
        ),
      )
      .returning({ id: agentRuns.id });
    if (stomped.length) {
      console.log(`[smoke-skill-doc] cancelled ${stomped.length} prior ${slug} run(s)`);
    }
  }

  // Drive learn-skill (this also kicks off skill-documentation).
  const learn = await createRun({
    userId: u.id,
    workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
    input: { skillId, prompt: SAMPLE_PROMPT, reason: "manual" },
    trigger: { kind: "manual" },
  });
  await enqueueRun(learn.runId);
  console.log(`[smoke-skill-doc] learn enqueued: ${learn.runId}`);

  const learnRun = await pollRun(learn.runId, "learn-skill", LEARN_TIMEOUT_MS);
  assert(
    learnRun.status === "completed",
    `learn status=${learnRun.status} error=${JSON.stringify(learnRun.error)}`,
  );

  const learnOut = learnRun.output as {
    revisionId: string;
    documentationRunId: string | null;
    documentationEnqueueStatus: "enqueued" | "deduplicated" | "failed";
  };
  console.log(
    `[smoke-skill-doc] learn output: v1Rev=${learnOut.revisionId} ` +
      `docStatus=${learnOut.documentationEnqueueStatus} docRun=${learnOut.documentationRunId ?? "null"}`,
  );
  assert(
    learnOut.documentationEnqueueStatus === "enqueued" && learnOut.documentationRunId,
    "expected learn-skill to enqueue a doc run",
  );
  const v1RevisionId = learnOut.revisionId;
  const docRunId = learnOut.documentationRunId!;

  // Now wait on skill-documentation.
  const docRun = await pollRun(docRunId, "skill-documentation", DOC_TIMEOUT_MS);
  assert(
    docRun.status === "completed",
    `doc status=${docRun.status} error=${JSON.stringify(docRun.error)}`,
  );
  const docOut = docRun.output as {
    skillId: string;
    revisionId: string;
    emailStatus: "sent" | "duplicate" | "failed";
    emailSendId: string;
    documentHitCount: number;
    memoryHitCount: number;
  };
  console.log(
    `[smoke-skill-doc] doc output: v2Rev=${docOut.revisionId} ` +
      `email=${docOut.emailStatus} sendId=${docOut.emailSendId} ` +
      `docHits=${docOut.documentHitCount} memHits=${docOut.memoryHitCount}`,
  );
  assert(docOut.skillId === skillId, "doc output skillId mismatch");
  assert(docOut.revisionId !== v1RevisionId, "v2 must be a fresh revision id");
  assert(docOut.emailStatus !== "failed", `email send failed: ${docOut.emailStatus}`);

  // Skill row points at v2.
  const [postSkill] = await db().select().from(skills).where(eq(skills.id, skillId));
  assert(postSkill, "skill row missing after doc");
  assert(
    postSkill.currentRevisionId === docOut.revisionId,
    `current_revision_id should be v2 (${docOut.revisionId}), got ${postSkill.currentRevisionId}`,
  );

  // v2 revision row + metadata.
  const [v2] = await db()
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.id, docOut.revisionId));
  assert(v2, "v2 skill_revisions row missing");
  assert(v2.kind === "documented", `expected v2 kind=documented, got ${v2.kind}`);
  const v2Meta = toRecord(v2.metadata);
  assert(v2Meta.previousRevisionId === v1RevisionId, "v2 metadata previousRevisionId mismatch");
  console.log(`[smoke-skill-doc] v2 body preview:\n${v2.body.slice(0, 600)}\n...`);

  // skill_runs row for the doc workflow.
  const [docSkillRun] = await db()
    .select()
    .from(skillRuns)
    .where(eq(skillRuns.agentRunId, docRunId));
  assert(docSkillRun, "skill_runs row for doc workflow missing");
  assert(
    docSkillRun.kind === "document",
    `expected skill_runs.kind=document, got ${docSkillRun.kind}`,
  );
  assert(
    docSkillRun.status === "completed",
    `expected skill_runs.status=completed, got ${docSkillRun.status}`,
  );

  // email_sends row idempotency-keyed on the v2 revision.
  const [emailRow] = await db()
    .select()
    .from(emailSends)
    .where(
      and(
        eq(emailSends.userId, u.id),
        eq(emailSends.idempotencyKey, `skill-doc:${docOut.revisionId}`),
      ),
    )
    .orderBy(desc(emailSends.createdAt))
    .limit(1);
  assert(emailRow, "email_sends row not found for v2 revision");
  console.log(
    `[smoke-skill-doc] email row: subject="${emailRow.subject}" status=${emailRow.status} providerMessageId=${emailRow.providerMessageId}`,
  );
  assert(
    emailRow.kind === "skill_documented",
    `expected emailSends.kind=skill_documented, got ${emailRow.kind}`,
  );

  console.log("\n[smoke-skill-doc] PASS");
}

main()
  .catch((err) => {
    console.error(
      "[smoke-skill-doc] FAIL",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAgentQueue().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

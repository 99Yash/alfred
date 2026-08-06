import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { SealedCredentialSecret, WorkflowRevisionDefinition } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import {
  agentRuns,
  integrationCredentials,
  user,
  workflowRevisions,
  workflows,
} from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { GMAIL_READONLY_SCOPE } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";

import { runOnce } from "../../src/modules/agent/executor";
import { createRun, findResumableRunIds, replayRun } from "../../src/modules/agent/service";
import { ENTITY_FETCHERS } from "../../src/modules/replicache/entities";
import { registerBuiltinTools } from "../../src/modules/tools/runtime";
import {
  registerWorkflowReadiness,
  unregisterWorkflowReadiness,
} from "../../src/composition/workflow-readiness";
import { dispatchDueCronWorkflows } from "../../src/modules/workflows/tick";
import {
  activateWorkflow,
  clearWorkflowBlocked,
  createWorkflowDraft,
  recoverWorkflowDraft,
  reviseWorkflow,
  setWorkflowBlocked,
  setWorkflowStatus,
} from "../../src/modules/workflows/revisions";

const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const createdUserIds: string[] = [];

function definition(brief: string): WorkflowRevisionDefinition {
  return {
    name: "Revision test",
    description: null,
    brief,
    trigger: { kind: "manual" as const },
    allowedIntegrations: ["system" as const],
    allowedTools: ["system.current_time"],
    requiredCapabilities: [{ tool: "system.current_time" }],
  };
}

async function seedUser(): Promise<string> {
  const userId = `test-workflow-revisions-${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Revision Test", email: `${userId}@example.test` });
  return userId;
}

describe("workflow revision invariants (#555)", { skip: SKIP }, () => {
  before(() => {
    registerBuiltinTools();
    // The sentinel's check-readiness step calls the registered readiness port
    // (item 10); wire it the way runtime composition does, else runOnce throws
    // "[agent] no workflow readiness check is registered".
    registerWorkflowReadiness();
  });

  after(async () => {
    unregisterWorkflowReadiness();
    for (const userId of createdUserIds) {
      await db().delete(user).where(eq(user.id, userId));
    }
    await closeConnections();
  });

  test("active edits stay visible as drafts while new runs pin the published revision", async () => {
    const userId = await seedUser();
    const slug = `revision-test-${randomUUID()}`;
    const created = await createWorkflowDraft({
      userId,
      slug,
      definition: definition("published brief"),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const activated = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(activated.ok, true);
    if (!activated.ok) return;

    const revised = await reviseWorkflow({
      userId,
      workflowId: created.workflow.id,
      definition: definition("unpublished brief"),
      expectedRowVersion: activated.workflow.rowVersion,
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;

    const synced = await ENTITY_FETCHERS.WORKFLOW(db(), userId);
    const entity = synced.find((row) => row.id === slug)?.serialized;
    assert.ok(entity && "slug" in entity && entity.slug === slug);
    if (!entity || !("slug" in entity) || entity.slug !== slug) return;
    assert.equal(entity.brief, "unpublished brief");
    assert.equal(entity.currentRevisionId, revised.revision.id);
    assert.equal(entity.publishedRevisionId, activated.revision.id);

    await assert.rejects(
      createRun({
        userId,
        workflowSlug: slug,
        workflowRevisionId: revised.revision.id,
        occurrence: {
          kind: "event",
          workflowId: created.workflow.id,
          provider: "test",
          eventId: "draft-revision-attempt",
        },
        trigger: {
          kind: "event",
          source: "test",
          type: "draft-revision",
          eventId: "draft-revision-attempt",
        },
      }),
      /no approved selected revision/,
    );

    const { runId } = await createRun({
      userId,
      workflowSlug: slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "published-revision-manual-run",
      },
    });
    const [run] = await db()
      .select({
        workflowRevisionId: agentRuns.workflowRevisionId,
        brief: agentRuns.brief,
        occurrenceKey: agentRuns.occurrenceKey,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    assert.equal(run?.workflowRevisionId, activated.revision.id);
    assert.equal(run?.brief, "published brief");
    assert.match(run?.occurrenceKey ?? "", /^occ_v1:manual:sha256:/);

    await db().update(agentRuns).set({ status: "completed" }).where(eq(agentRuns.id, runId));
    const duplicate = await createRun({
      userId,
      workflowSlug: slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "published-revision-manual-run",
      },
    });
    assert.equal(duplicate.runId, runId, "terminal status must not release the occurrence key");
    assert.equal(duplicate.created, false);

    for (const occurrence of [
      {
        occurrence: {
          kind: "event",
          workflowId: created.workflow.id,
          provider: "gmail",
          eventId: "delivery-1",
        },
        trigger: {
          kind: "event" as const,
          source: "gmail",
          type: "message_received",
          eventId: "delivery-1",
        },
      },
      {
        occurrence: {
          kind: "cron",
          workflowId: created.workflow.id,
          revisionId: activated.revision.id,
          scheduledFor: "2026-08-01T07:00:00.000Z",
        },
        trigger: { kind: "cron" as const, scheduledFor: "2026-08-01T07:00:00.000Z" },
      },
    ]) {
      const first = await createRun({
        userId,
        workflowSlug: slug,
        workflowRevisionId: activated.revision.id,
        occurrence: occurrence.occurrence,
        trigger: occurrence.trigger,
      });
      await db()
        .update(agentRuns)
        .set({ status: "completed" })
        .where(eq(agentRuns.id, first.runId));
      const redelivery = await createRun({
        userId,
        workflowSlug: slug,
        workflowRevisionId: activated.revision.id,
        occurrence: occurrence.occurrence,
        trigger: occurrence.trigger,
      });
      assert.equal(redelivery.runId, first.runId);
      assert.equal(redelivery.created, false);
    }

    const pending = await createRun({
      userId,
      workflowSlug: slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "claimed-before-enqueue",
      },
    });
    assert.ok(
      (await findResumableRunIds({ limit: 1_000 })).includes(pending.runId),
      "the recovery sweep must find a claimed row when enqueue did not happen",
    );
  });

  test("a stale concurrent edit returns a typed row-version conflict", async () => {
    const userId = await seedUser();
    const created = await createWorkflowDraft({
      userId,
      slug: `revision-race-${randomUUID()}`,
      definition: definition("v1"),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const first = await reviseWorkflow({
      userId,
      workflowId: created.workflow.id,
      definition: definition("v2"),
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(first.ok, true);

    const stale = await reviseWorkflow({
      userId,
      workflowId: created.workflow.id,
      definition: definition("v3"),
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.deepEqual(stale, {
      ok: false,
      failure: {
        kind: "row_version_conflict",
        expected: created.workflow.rowVersion,
      },
    });

    const revisions = await db()
      .select()
      .from(workflowRevisions)
      .where(eq(workflowRevisions.workflowId, created.workflow.id));
    assert.equal(revisions.length, 2);
    const [workflow] = await db()
      .select()
      .from(workflows)
      .where(eq(workflows.id, created.workflow.id));
    assert.equal(workflow?.currentRevisionId, first.ok ? first.revision.id : null);
  });

  test("replay creates a linked occurrence with an explicit revision choice", async () => {
    const userId = await seedUser();
    const slug = `replay-${randomUUID()}`;
    const created = await createWorkflowDraft({
      userId,
      slug,
      definition: definition("original brief"),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const activatedOriginal = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(activatedOriginal.ok, true);
    if (!activatedOriginal.ok) return;

    const source = await createRun({
      userId,
      workflowSlug: slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "source",
      },
    });
    const revised = await reviseWorkflow({
      userId,
      workflowId: created.workflow.id,
      definition: definition("latest brief"),
      expectedRowVersion: activatedOriginal.workflow.rowVersion,
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    const activatedLatest = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: revised.workflow.rowVersion,
    });
    assert.equal(activatedLatest.ok, true);
    if (!activatedLatest.ok) return;

    const originalReplay = await replayRun({
      userId,
      runId: source.runId,
      requestId: "replay-original",
      revisionChoice: "original",
    });
    const latestReplay = await replayRun({
      userId,
      runId: source.runId,
      requestId: "replay-latest",
      revisionChoice: "latest",
    });
    const replayRows = await db()
      .select({
        id: agentRuns.id,
        replayOfRunId: agentRuns.replayOfRunId,
        workflowRevisionId: agentRuns.workflowRevisionId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.replayOfRunId, source.runId));
    const originalRow = replayRows.find((row) => row.id === originalReplay.runId);
    const latestRow = replayRows.find((row) => row.id === latestReplay.runId);
    assert.equal(originalRow?.workflowRevisionId, activatedOriginal.revision.id);
    assert.equal(latestRow?.workflowRevisionId, activatedLatest.revision.id);
    assert.equal(originalRow?.replayOfRunId, source.runId);
    assert.equal(latestRow?.replayOfRunId, source.runId);

    const duplicate = await replayRun({
      userId,
      runId: source.runId,
      requestId: "replay-latest",
      revisionChoice: "latest",
    });
    assert.equal(duplicate.runId, latestReplay.runId);
    assert.equal(duplicate.created, false);
  });

  test("cron claim and cursor advance survive an enqueue failure as one pending occurrence", async () => {
    const userId = await seedUser();
    const slug = `cron-occurrence-${randomUUID()}`;
    const created = await createWorkflowDraft({
      userId,
      slug,
      definition: {
        ...definition("cron occurrence"),
        trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
      },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const activated = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(activated.ok, true);
    if (!activated.ok) return;

    const scheduledFor = new Date(Date.now() - 60_000);
    await db()
      .update(workflows)
      .set({ nextRunAt: scheduledFor })
      .where(eq(workflows.id, created.workflow.id));
    // Faithfully replicate `startRunInTx`: commit the CAS claim + run row in
    // one transaction, then simulate a Redis outage on the post-commit
    // enqueue. The row must survive as `pending` for the resume sweep.
    const tick = await dispatchDueCronWorkflows(new Date(), {
      startRunInTx: async (spec) => {
        const created = await db().transaction(async (tx) => {
          const args = await spec.claim(tx);
          if (!args) return null;
          return createRun(args, tx);
        });
        if (!created) return null;
        throw new Error("simulated Redis outage after commit");
      },
    });
    assert.equal(tick.failed, 1);

    const [run] = await db()
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        occurrenceKey: agentRuns.occurrenceKey,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.workflowSlug, slug)))
      .limit(1);
    assert.equal(run?.status, "pending");
    assert.match(run?.occurrenceKey ?? "", /^occ_v1:cron:sha256:/);
    assert.ok(run && (await findResumableRunIds({ limit: 1_000 })).includes(run.id));

    const [workflow] = await db()
      .select({ nextRunAt: workflows.nextRunAt, lastScheduledAt: workflows.lastScheduledAt })
      .from(workflows)
      .where(eq(workflows.id, created.workflow.id));
    assert.equal(workflow?.lastScheduledAt?.toISOString(), scheduledFor.toISOString());
    assert.ok(workflow?.nextRunAt && workflow.nextRunAt > scheduledFor);
  });

  test("credential loss blocks the occurrence before the first model turn", async () => {
    const userId = await seedUser();
    const accountRef = `google-${randomUUID()}`;
    const [credential] = await db()
      .insert(integrationCredentials)
      .values({
        userId,
        provider: "google",
        accountId: accountRef,
        accountLabel: "test@example.test",
        accessToken: "test-token" as unknown as SealedCredentialSecret,
        scopes: [GMAIL_READONLY_SCOPE],
        status: "active",
      })
      .returning({ id: integrationCredentials.id });
    assert.ok(credential);

    const slug = `readiness-loss-${randomUUID()}`;
    const created = await createWorkflowDraft({
      userId,
      slug,
      definition: {
        name: "Credential loss",
        description: null,
        brief: "Search Gmail.",
        trigger: { kind: "manual" },
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef }],
      },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const activated = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(activated.ok, true);
    if (!activated.ok) return;

    await db()
      .update(integrationCredentials)
      .set({ status: "needs_reauth" })
      .where(eq(integrationCredentials.id, credential.id));
    const run = await createRun({
      userId,
      workflowSlug: slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "credential-loss",
      },
    });
    const outcome = await runOnce(run.runId);
    assert.equal(outcome.kind, "blocked");

    const [storedRun] = await db()
      .select({ status: agentRuns.status, currentStep: agentRuns.currentStep })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.runId));
    assert.equal(storedRun?.status, "blocked");
    assert.equal(storedRun?.currentStep, "check-readiness");
    const [storedWorkflow] = await db()
      .select({ blocked: workflows.blocked })
      .from(workflows)
      .where(eq(workflows.id, created.workflow.id));
    assert.equal(storedWorkflow?.blocked?.code, "needs_reauth");
  });

  test("an old pinned run cannot block a newly published revision", async () => {
    const userId = await seedUser();
    const accountRef = `google-${randomUUID()}`;
    const [credential] = await db()
      .insert(integrationCredentials)
      .values({
        userId,
        provider: "google",
        accountId: accountRef,
        accountLabel: "stale@example.test",
        accessToken: "test-token" as unknown as SealedCredentialSecret,
        scopes: [GMAIL_READONLY_SCOPE],
        status: "active",
      })
      .returning({ id: integrationCredentials.id });
    assert.ok(credential);

    const slug = `stale-readiness-${randomUUID()}`;
    const created = await createWorkflowDraft({
      userId,
      slug,
      definition: {
        name: "Old Gmail revision",
        description: null,
        brief: "Search Gmail.",
        trigger: { kind: "manual" },
        allowedIntegrations: ["gmail"],
        allowedTools: ["gmail.search"],
        requiredCapabilities: [{ tool: "gmail.search", accountRef }],
      },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const activatedV1 = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(activatedV1.ok, true);
    if (!activatedV1.ok) return;
    const oldRun = await createRun({
      userId,
      workflowSlug: slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "old-revision",
      },
    });

    const revised = await reviseWorkflow({
      userId,
      workflowId: created.workflow.id,
      definition: definition("Current healthy revision"),
      expectedRowVersion: activatedV1.workflow.rowVersion,
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    const activatedV2 = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: revised.workflow.rowVersion,
    });
    assert.equal(activatedV2.ok, true);
    if (!activatedV2.ok) return;

    await db()
      .update(integrationCredentials)
      .set({ status: "needs_reauth" })
      .where(eq(integrationCredentials.id, credential.id));
    const outcome = await runOnce(oldRun.runId);
    assert.equal(outcome.kind, "blocked");
    const [storedWorkflow] = await db()
      .select({ blocked: workflows.blocked, publishedRevisionId: workflows.publishedRevisionId })
      .from(workflows)
      .where(eq(workflows.id, created.workflow.id));
    assert.equal(storedWorkflow?.blocked, null);
    assert.equal(storedWorkflow?.publishedRevisionId, activatedV2.revision.id);
  });

  test("connection recovery revalidates the same immutable draft and presents activation", async () => {
    const userId = await seedUser();
    const created = await createWorkflowDraft({
      userId,
      slug: `revision-recovery-${randomUUID()}`,
      definition: definition("recover this draft"),
      authoringProposal: {
        intent: "Report the current time.",
        assumptions: [],
        externalEffects: [],
        requestedCapabilities: [{ tool: "system.current_time" }],
        scheduleSummary: "Run manually",
      },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const blocked = await setWorkflowBlocked({
      userId,
      workflowId: created.workflow.id,
      blocked: {
        code: "not_connected",
        message: "Connect the required account.",
        detectedAt: new Date().toISOString(),
        revisionId: created.revision.id,
      },
    });
    assert.equal(blocked.ok, true);

    const recovered = await recoverWorkflowDraft({
      userId,
      workflowId: created.workflow.id,
      revisionId: created.revision.id,
    });
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.deepEqual(recovered.readiness, []);
    assert.equal(recovered.workflow.blocked, null);
    assert.equal(recovered.revision.id, created.revision.id);
    assert.equal(recovered.activationProposal?.baseRevisionId, created.revision.id);
    assert.equal(recovered.activationProposal?.baseContentHash, created.revision.contentHash);
    assert.equal(recovered.activationProposal?.baseRowVersion, recovered.workflow.rowVersion);

    const revisions = await db()
      .select({ id: workflowRevisions.id })
      .from(workflowRevisions)
      .where(eq(workflowRevisions.workflowId, created.workflow.id));
    assert.deepEqual(revisions, [{ id: created.revision.id }]);
  });

  test("connection recovery refuses a draft that changed during OAuth", async () => {
    const userId = await seedUser();
    const created = await createWorkflowDraft({
      userId,
      slug: `revision-recovery-stale-${randomUUID()}`,
      definition: definition("before OAuth"),
      authoringProposal: {
        intent: "Report the current time.",
        assumptions: [],
        externalEffects: [],
        requestedCapabilities: [{ tool: "system.current_time" }],
      },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const revised = await reviseWorkflow({
      userId,
      workflowId: created.workflow.id,
      definition: definition("edited during OAuth"),
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;

    const recovered = await recoverWorkflowDraft({
      userId,
      workflowId: created.workflow.id,
      revisionId: created.revision.id,
    });
    assert.equal(recovered.ok, false);
    if (recovered.ok) return;
    assert.equal(recovered.failure.kind, "stale_revision");
    if (recovered.failure.kind !== "stale_revision") return;
    assert.equal(recovered.failure.expectedRevisionId, created.revision.id);
    assert.equal(recovered.failure.actualRevisionId, revised.revision.id);
  });

  test("pause and operational blockers remain independent", async () => {
    const userId = await seedUser();
    const created = await createWorkflowDraft({
      userId,
      slug: `revision-blocked-${randomUUID()}`,
      definition: definition("blocked workflow"),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const activated = await activateWorkflow({
      userId,
      workflowId: created.workflow.id,
      expectedRowVersion: created.workflow.rowVersion,
    });
    assert.equal(activated.ok, true);
    if (!activated.ok) return;

    const blocked = {
      code: "reauth_required",
      message: "Reconnect the account before this workflow can run.",
      detectedAt: new Date().toISOString(),
      revisionId: activated.revision.id,
    };
    const blockedResult = await setWorkflowBlocked({
      userId,
      workflowId: created.workflow.id,
      blocked,
    });
    assert.equal(blockedResult.ok, true);

    const paused = await setWorkflowStatus({
      userId,
      workflowId: created.workflow.id,
      status: "paused",
    });
    assert.equal(paused.ok, true);
    if (!paused.ok) return;
    assert.deepEqual(paused.workflow.blocked, blocked, "pausing must preserve the blocker");

    const cleared = await clearWorkflowBlocked({
      userId,
      workflowId: created.workflow.id,
    });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    assert.equal(cleared.workflow.blocked, null);
    assert.equal(cleared.workflow.status, "paused", "recovery must not resume user-paused work");
  });
});

describe("workflow revision content hash (#555)", () => {
  test("the same definition hashes identically in separate processes", () => {
    const first: WorkflowRevisionDefinition = {
      name: "Canonical hash test",
      description: null,
      brief: "Report new inbox messages.",
      trigger: { kind: "manual" },
      allowedIntegrations: ["gmail", "system"],
      allowedTools: ["gmail.search", "system.current_time"],
      requiredCapabilities: [
        {
          tool: "gmail.search",
          accountRef: "primary",
          resourceScope: { label: "inbox", unreadOnly: true },
        },
        { tool: "system.current_time" },
      ],
    };
    const second: WorkflowRevisionDefinition = {
      requiredCapabilities: [
        { tool: "system.current_time" },
        {
          resourceScope: { unreadOnly: true, label: "inbox" },
          accountRef: "primary",
          tool: "gmail.search",
        },
      ],
      allowedTools: ["system.current_time", "gmail.search"],
      allowedIntegrations: ["system", "gmail"],
      trigger: { kind: "manual" },
      brief: "Report new inbox messages.",
      description: null,
      name: "Canonical hash test",
    };

    const firstHash = hashInSeparateProcess(first);
    const secondHash = hashInSeparateProcess(second);
    assert.match(firstHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(secondHash, firstHash);
  });
});

function hashInSeparateProcess(definition: WorkflowRevisionDefinition): string {
  const moduleUrl = new URL("../../src/modules/workflows/content-hash.ts", import.meta.url).href;
  const script = `
    const { workflowRevisionContentHash } = await import(${JSON.stringify(moduleUrl)});
    const definition = JSON.parse(process.env.ALFRED_TEST_WORKFLOW_DEFINITION);
    process.stdout.write(workflowRevisionContentHash(definition));
  `;
  return execFileSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ALFRED_TEST_WORKFLOW_DEFINITION: JSON.stringify(definition),
      },
    },
  );
}

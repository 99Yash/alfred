import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { WorkflowRevisionDefinition } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentRuns, user, workflowRevisions, workflows } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq } from "drizzle-orm";

import { createRun } from "../../src/modules/agent/service";
import { ENTITY_FETCHERS } from "../../src/modules/replicache/entities";
import { registerBuiltinTools } from "../../src/modules/tools";
import {
  activateWorkflow,
  clearWorkflowBlocked,
  createWorkflowDraft,
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
  before(() => registerBuiltinTools());

  after(async () => {
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
      requestId: "published-revision-manual-run",
      trigger: { kind: "manual" },
    });
    const [run] = await db()
      .select({
        workflowRevisionId: agentRuns.workflowRevisionId,
        brief: agentRuns.brief,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    assert.equal(run?.workflowRevisionId, activated.revision.id);
    assert.equal(run?.brief, "published brief");
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

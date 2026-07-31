import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentRuns, user, workflowRevisions, workflows } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq } from "drizzle-orm";

import { createRun } from "../../src/modules/agent/service";
import { ENTITY_FETCHERS } from "../../src/modules/replicache/entities";
import {
  activateWorkflow,
  createWorkflowDraft,
  reviseWorkflow,
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

function definition(brief: string) {
  return {
    name: "Revision test",
    description: null,
    brief,
    trigger: { kind: "manual" as const },
    allowedIntegrations: ["system" as const],
    allowedTools: [],
    requiredCapabilities: [],
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

    const { runId } = await createRun({
      userId,
      workflowSlug: slug,
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
});

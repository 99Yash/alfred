import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import {
  activateWorkflowInputSchema,
  authorWorkflowInputSchema,
  getPath,
  isRecord,
} from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user, workflowRevisions, workflows } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { asc, eq } from "drizzle-orm";

import { systemTools } from "../../src/modules/tools/system";
import { registerBuiltinTools } from "../../src/modules/tools";
import { toolExecuteContext } from "../../src/modules/tools/context";
import { definitionFromProposal } from "../../src/modules/workflows/authoring";

const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const authorTool = systemTools.find((tool) => tool.name === "system.author_workflow");
const activateTool = systemTools.find((tool) => tool.name === "system.activate_workflow");

before(() => registerBuiltinTools());

describe("workflow authoring tool contracts (#556)", () => {
  test("only chat bosses can draft or activate, and activation keeps the high-risk floor", () => {
    assert.ok(authorTool);
    assert.ok(activateTool);
    assert.deepEqual(authorTool.availability, { requiresThread: true, callers: ["boss"] });
    assert.deepEqual(activateTool.availability, { requiresThread: true, callers: ["boss"] });
    assert.equal(authorTool.riskTier, "no_risk");
    assert.equal(activateTool.riskTier, "high");
    assert.equal(activateTool.staging, "staged");
  });

  test("the authorable trigger subset rejects internal signals and non-Gmail events", () => {
    const base = {
      name: "Inbox summary",
      brief: "Summarize new inbox messages.",
      capabilities: [{ tool: "gmail.search" as const }],
      intent: "Summarize my inbox.",
      assumptions: [],
      externalEffects: [],
    };
    assert.equal(
      authorWorkflowInputSchema.safeParse({
        ...base,
        trigger: { kind: "on_signal", name: "cold-start.ready" },
      }).success,
      false,
    );
    assert.equal(
      authorWorkflowInputSchema.safeParse({
        ...base,
        trigger: { kind: "event", source: "learn-skill", type: "completed" },
      }).success,
      false,
    );
    assert.equal(
      authorWorkflowInputSchema.safeParse({
        ...base,
        trigger: { kind: "cron", schedule: "0 8 * * 1-5" },
      }).success,
      false,
      "cron authoring must resolve an IANA timezone before it can save",
    );
    assert.equal(
      authorWorkflowInputSchema.safeParse({
        ...base,
        trigger: { kind: "cron", schedule: "0 0 8 * * 1-5", timezone: "Asia/Kolkata" },
      }).success,
      false,
      "workflow authoring accepts exactly five cron fields",
    );
    assert.equal(
      activateWorkflowInputSchema.safeParse({
        workflowId: "wf",
        baseRevisionId: "rev",
        baseContentHash: "sha256:base",
        baseRowVersion: 1,
        definition: {
          name: "Internal signal",
          description: null,
          brief: "Run on an internal signal.",
          trigger: { kind: "on_signal", name: "cold-start.ready" },
          allowedIntegrations: ["system"],
          allowedTools: ["system.current_time"],
          requiredCapabilities: [{ tool: "system.current_time" }],
        },
        schedule: {
          summary: "On signal: cold-start.ready",
          timezone: "Asia/Kolkata",
          previewedAt: "2026-07-31T00:00:00.000Z",
        },
        authoringProposal: {
          intent: "Run internally.",
          assumptions: [],
          externalEffects: [],
          requestedCapabilities: [{ tool: "system.current_time" }],
        },
      }).success,
      false,
      "approval edits cannot widen the v1 trigger subset",
    );
  });

  test("derives an exact deduplicated tool envelope and trigger-source ceiling", () => {
    const input = authorWorkflowInputSchema.parse({
      name: "Inbox summary",
      brief: "Summarize every new inbox message.",
      trigger: { kind: "event", source: "gmail", type: "message_received" },
      capabilities: [{ tool: "gmail.search" }, { tool: "gmail.search" }],
      intent: "Summarize my inbox.",
      assumptions: [],
      externalEffects: [],
    });
    const definition = definitionFromProposal(input);
    assert.deepEqual(definition.allowedIntegrations, ["gmail"]);
    assert.deepEqual(definition.allowedTools, ["gmail.search"]);
    assert.deepEqual(definition.requiredCapabilities, [{ tool: "gmail.search" }]);
  });
});

describe("workflow authoring and activation acceptance (#556)", { skip: SKIP }, () => {
  const userIds: string[] = [];

  after(async () => {
    for (const userId of userIds) await db().delete(user).where(eq(user.id, userId));
    await closeConnections();
  });

  test("chat draft → exact activation card → edited immutable revision is published", async () => {
    assert.ok(authorTool);
    assert.ok(activateTool);
    const userId = await seedUser(userIds);
    const authorResult = await authorTool.execute(
      {
        name: "Weekday inbox brief",
        description: "A concise inbox brief.",
        brief: "Every weekday, summarize unread messages that need my attention.",
        trigger: { kind: "cron", schedule: "0 8 * * 1-5", timezone: "Asia/Kolkata" },
        capabilities: [{ tool: "system.current_time" }],
        intent: "Brief me on important unread mail before work.",
        assumptions: [],
        externalEffects: [],
      },
      context(userId, "author-run"),
    );
    assert.ok(isRecord(authorResult));
    assert.equal(authorResult.status, "ready_to_activate");

    const proposal = activateWorkflowInputSchema.parse(getPath(authorResult, "activationProposal"));
    assert.equal(proposal.schedule.summary, "Cron schedule: 0 8 * * 1-5");
    assert.match(proposal.schedule.nextRunAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(proposal.definition.allowedTools, ["system.current_time"]);
    assert.deepEqual(proposal.authoringProposal.assumptions, []);

    const editedBrief = "Every weekday, summarize only urgent unread messages.";
    const activateResult = await activateTool.execute(
      { ...proposal, definition: { ...proposal.definition, brief: editedBrief } },
      context(userId, "activate-run"),
    );
    assert.ok(isRecord(activateResult));
    assert.equal(activateResult.status, "activated");
    assert.equal(activateResult.revisedFromApprovalEdit, true);

    const revisions = await db()
      .select()
      .from(workflowRevisions)
      .where(eq(workflowRevisions.workflowId, proposal.workflowId))
      .orderBy(asc(workflowRevisions.revisionNumber));
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0]?.brief, proposal.definition.brief);
    assert.equal(revisions[0]?.approvedAt, null, "the base revision must remain unchanged");
    assert.equal(revisions[1]?.brief, editedBrief);
    assert.ok(revisions[1]?.approvedAt);

    const [workflow] = await db()
      .select()
      .from(workflows)
      .where(eq(workflows.id, proposal.workflowId));
    assert.equal(workflow?.status, "active");
    assert.equal(workflow?.currentRevisionId, revisions[1]?.id);
    assert.equal(workflow?.publishedRevisionId, revisions[1]?.id);
  });

  test("a stale content hash refuses activation", async () => {
    assert.ok(authorTool);
    assert.ok(activateTool);
    const userId = await seedUser(userIds);
    const authorResult = await authorTool.execute(
      {
        name: "Manual review",
        brief: "Review the current inbox when I ask.",
        trigger: { kind: "manual" },
        capabilities: [{ tool: "system.current_time" }],
        intent: "Save a manual inbox review.",
        assumptions: [],
        externalEffects: [],
      },
      context(userId, "stale-author-run"),
    );
    const proposal = activateWorkflowInputSchema.parse(getPath(authorResult, "activationProposal"));
    const result = await activateTool.execute(
      { ...proposal, baseContentHash: "sha256:stale" },
      context(userId, "stale-activate-run"),
    );
    assert.ok(isRecord(result));
    assert.equal(result.status, "stale_revision");

    const [workflow] = await db()
      .select({ status: workflows.status, publishedRevisionId: workflows.publishedRevisionId })
      .from(workflows)
      .where(eq(workflows.id, proposal.workflowId));
    assert.equal(workflow?.status, "draft");
    assert.equal(workflow?.publishedRevisionId, null);
  });

  test("a disconnected capability saves a blocked draft without an activation proposal", async () => {
    assert.ok(authorTool);
    const userId = await seedUser(userIds);
    const result = await authorTool.execute(
      {
        name: "Disconnected inbox review",
        brief: "Review Gmail.",
        trigger: { kind: "manual" },
        capabilities: [{ tool: "gmail.search" }],
        intent: "Review my inbox.",
        assumptions: [],
        externalEffects: [],
      },
      context(userId, "blocked-author-run"),
    );
    assert.ok(isRecord(result));
    assert.equal(result.status, "blocked");
    assert.equal(getPath(result, "activationProposal"), undefined);
    assert.equal(getPath(result, "readinessBlockers.0.code"), "not_connected");
  });
});

async function seedUser(userIds: string[]): Promise<string> {
  const userId = `test-workflow-authoring-${randomUUID()}`;
  userIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Workflow Author", email: `${userId}@example.test` });
  return userId;
}

function context(userId: string, runId: string) {
  return toolExecuteContext({
    runId,
    scratchpadRunId: runId,
    stepId: "boss-turn",
    toolCallId: randomUUID(),
    userId,
    timezone: "Asia/Kolkata",
    caller: "boss",
    threadId: "thread-1",
    messageId: "message-1",
  });
}

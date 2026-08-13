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
import { agentRuns, user, workflowRevisions, workflows } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { asc, eq } from "drizzle-orm";

import { systemTools } from "../../src/modules/tools/system";
import { registerBuiltinTools } from "../../src/modules/tools/runtime";
import { registerWorkflowSystemToolAdapter } from "@alfred/assistant/automation/system-tool-adapter";
import { toolExecuteContext } from "@alfred/assistant/tool-runtime/context";
import { definitionFromProposal } from "@alfred/assistant/automation/authoring";
import { refreshWorkflowActivationProposal } from "@alfred/assistant/automation/revisions";
import { createRun } from "@alfred/assistant/execution/service";

const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const authorTool = systemTools.find((tool) => tool.name === "system.author_workflow");
const recoverTool = systemTools.find((tool) => tool.name === "system.recover_workflow");
const activateTool = systemTools.find((tool) => tool.name === "system.activate_workflow");

before(() => {
  registerBuiltinTools();
  // The workflow tools route through the tool-runtime seam; install the
  // workflows-owned handler so `execute` resolves instead of the boot-order throw.
  registerWorkflowSystemToolAdapter();
});

describe("workflow authoring tool contracts (#556)", () => {
  test("only chat bosses can draft, recover, or activate, and activation keeps the high-risk floor", () => {
    assert.ok(authorTool);
    assert.ok(recoverTool);
    assert.ok(activateTool);
    assert.deepEqual(authorTool.availability, { requiresLiveChat: true, callers: ["boss"] });
    assert.deepEqual(recoverTool.availability, { requiresLiveChat: true, callers: ["boss"] });
    assert.deepEqual(activateTool.availability, { requiresLiveChat: true, callers: ["boss"] });
    assert.equal(authorTool.riskTier, "no_risk");
    assert.equal(recoverTool.riskTier, "no_risk");
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

  test("accepts an unsupported requested capability so readiness can preserve the draft", () => {
    const parsed = authorWorkflowInputSchema.parse({
      name: "Slack follow-up",
      brief: "Post a follow-up in Slack.",
      trigger: { kind: "manual" },
      capabilities: [{ tool: "slack.send_message" }],
      intent: "Follow up in Slack.",
      assumptions: [],
      externalEffects: ["send a Slack message"],
    });
    const definition = definitionFromProposal(parsed);
    assert.deepEqual(definition.allowedIntegrations, ["slack"]);
    assert.deepEqual(definition.allowedTools, []);
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
    assert.equal(proposal.schedule.summary, "Every weekday at 8:00 AM (Asia/Kolkata)");
    assert.match(proposal.schedule.nextRunAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(proposal.definition.allowedTools, ["system.current_time"]);
    assert.deepEqual(proposal.resolvedCapabilities, [
      { tool: "system.current_time", title: "check the current time" },
    ]);
    assert.deepEqual(proposal.resolvedAccounts, []);
    assert.deepEqual(proposal.authoringProposal.assumptions, []);

    assert.ok(recoverTool);
    const recoveredResult = await recoverTool.execute(
      { workflowId: proposal.workflowId, revisionId: proposal.baseRevisionId },
      context(userId, "author-run"),
    );
    assert.ok(isRecord(recoveredResult));
    assert.equal(recoveredResult.status, "ready_to_activate");
    assert.deepEqual(
      activateWorkflowInputSchema.parse(getPath(recoveredResult, "activationProposal")).definition,
      proposal.definition,
    );

    const editedBrief = "Every weekday, summarize only urgent unread messages.";
    const editedActivation = {
      ...proposal,
      definition: {
        ...proposal.definition,
        brief: editedBrief,
      },
    };
    const activateResult = await activateTool.execute(
      editedActivation,
      context(userId, "author-run"),
    );
    assert.ok(isRecord(activateResult));
    assert.equal(activateResult.status, "activated");
    assert.equal(activateResult.revisedFromApprovalEdit, true);

    const retriedActivation = await activateTool.execute(
      editedActivation,
      context(userId, "author-run"),
    );
    assert.ok(isRecord(retriedActivation));
    assert.equal(retriedActivation.status, "activated");
    assert.equal(retriedActivation.revisedFromApprovalEdit, true);

    const revisions = await db()
      .select()
      .from(workflowRevisions)
      .where(eq(workflowRevisions.workflowId, proposal.workflowId))
      .orderBy(asc(workflowRevisions.revisionNumber));
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0]?.brief, proposal.definition.brief);
    assert.equal(revisions[0]?.approvedAt, null, "the base revision must remain unchanged");
    assert.equal(revisions[1]?.brief, editedBrief);
    assert.deepEqual(revisions[1]?.trigger, proposal.definition.trigger);
    assert.ok(revisions[1]?.approvedAt);

    const [workflow] = await db()
      .select()
      .from(workflows)
      .where(eq(workflows.id, proposal.workflowId));
    assert.equal(workflow?.status, "active");
    assert.equal(workflow?.currentRevisionId, revisions[1]?.id);
    assert.equal(workflow?.publishedRevisionId, revisions[1]?.id);

    const firstManual = await createRun({
      userId,
      workflowSlug: workflow!.slug,
      brief: "Unapproved replacement brief.",
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "manual-request-1",
      },
    });
    const retriedManual = await createRun({
      userId,
      workflowSlug: workflow!.slug,
      brief: "Another unapproved replacement.",
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "manual-request-1",
      },
    });
    assert.equal(retriedManual.runId, firstManual.runId);
    const [manualRun] = await db()
      .select({ brief: agentRuns.brief, workflowRevisionId: agentRuns.workflowRevisionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, firstManual.runId));
    assert.equal(manualRun?.brief, editedBrief);
    assert.equal(manualRun?.workflowRevisionId, revisions[1]?.id);

    await db()
      .update(agentRuns)
      .set({ status: "failed" })
      .where(eq(agentRuns.id, firstManual.runId));
    const terminalRetry = await createRun({
      userId,
      workflowSlug: workflow!.slug,
      trigger: { kind: "manual" },
      occurrence: {
        kind: "manual",
        requestId: "manual-request-1",
      },
    });
    assert.equal(terminalRetry.runId, firstManual.runId);
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

  test("a schedule edit is rebuilt into a fresh contract before activation", async () => {
    assert.ok(authorTool);
    assert.ok(activateTool);
    const userId = await seedUser(userIds);
    const authorResult = await authorTool.execute(
      {
        name: "Editable morning check",
        brief: "Check the current time every weekday morning.",
        trigger: { kind: "cron", schedule: "0 8 * * 1-5", timezone: "Asia/Kolkata" },
        capabilities: [{ tool: "system.current_time" }],
        intent: "Run a weekday morning check.",
        assumptions: [],
        externalEffects: [],
      },
      context(userId, "refresh-author-run"),
    );
    const proposal = activateWorkflowInputSchema.parse(getPath(authorResult, "activationProposal"));
    const refreshed = await refreshWorkflowActivationProposal({
      userId,
      input: {
        ...proposal,
        definition: {
          ...proposal.definition,
          trigger: { kind: "cron", schedule: "0 9 * * 1-5", timezone: "Asia/Kolkata" },
        },
        authoringProposal: {
          ...proposal.authoringProposal,
          scheduleSummary: "tampered model summary",
        },
      },
    });
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) return;
    assert.equal(refreshed.input.schedule.summary, "Every weekday at 9:00 AM (Asia/Kolkata)");
    assert.equal(
      refreshed.input.authoringProposal.scheduleSummary,
      "Every weekday at 9:00 AM (Asia/Kolkata)",
    );

    const activated = await activateTool.execute(
      refreshed.input,
      context(userId, "refresh-activate-run"),
    );
    assert.ok(isRecord(activated));
    assert.equal(activated.status, "activated");
    assert.equal(activated.revisedFromApprovalEdit, true);
  });

  test("activation rejects a proposal summary that the server did not derive", async () => {
    assert.ok(authorTool);
    assert.ok(activateTool);
    const userId = await seedUser(userIds);
    const authorResult = await authorTool.execute(
      {
        name: "Protected proposal",
        brief: "Check the current time on request.",
        trigger: { kind: "manual" },
        capabilities: [{ tool: "system.current_time" }],
        intent: "Run a manual check.",
        assumptions: [],
        externalEffects: [],
      },
      context(userId, "proposal-author-run"),
    );
    const proposal = activateWorkflowInputSchema.parse(getPath(authorResult, "activationProposal"));
    const result = await activateTool.execute(
      {
        ...proposal,
        authoringProposal: { ...proposal.authoringProposal, intent: "Misleading intent." },
      },
      context(userId, "proposal-activate-run"),
    );
    assert.ok(isRecord(result));
    assert.equal(result.status, "validation_failed");
  });

  test("changed assumptions create an attributable revision", async () => {
    assert.ok(authorTool);
    const userId = await seedUser(userIds);
    const input = {
      name: "Manual review",
      brief: "Review the current inbox when I ask.",
      trigger: { kind: "manual" as const },
      capabilities: [{ tool: "system.current_time" as const }],
      intent: "Save a manual inbox review.",
      assumptions: ["Use the current timezone."],
      externalEffects: [] as string[],
    };
    const first = await authorTool.execute(input, context(userId, "assumption-author-1"));
    const firstProposal = activateWorkflowInputSchema.parse(getPath(first, "activationProposal"));

    const second = await authorTool.execute(
      {
        ...input,
        workflowId: firstProposal.workflowId,
        expectedRowVersion: firstProposal.baseRowVersion,
        assumptions: ["Use the current timezone and keep the answer concise."],
      },
      context(userId, "assumption-author-2"),
    );
    const secondProposal = activateWorkflowInputSchema.parse(getPath(second, "activationProposal"));
    assert.notEqual(secondProposal.baseRevisionId, firstProposal.baseRevisionId);
    assert.deepEqual(secondProposal.authoringProposal.assumptions, [
      "Use the current timezone and keep the answer concise.",
    ]);
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
    assert.equal(typeof getPath(result, "rowVersion"), "number");
    const readinessBlockers = getPath(result, "readinessBlockers");
    assert.ok(Array.isArray(readinessBlockers));
    assert.equal(getPath(readinessBlockers[0], "code"), "not_connected");
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
    runContext: { caller: "boss", interaction: "live_chat" },
    threadId: "thread-1",
    messageId: "message-1",
  });
}

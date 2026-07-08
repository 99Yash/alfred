import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { agentDecisionTraces, agentRuns, documents, emailTriage, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { and, eq, inArray, like } from "drizzle-orm";

import { runOnce } from "../../src/modules/agent/executor";
import { _resetRegistryForTests, registerWorkflow } from "../../src/modules/agent/registry";
import type { StepResult, Workflow } from "../../src/modules/agent/types";
import { upsertTriage, type SenderExtractionEvent } from "../../src/modules/triage";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-triage-decision-trace-";
const createdUserIds: string[] = [];

interface TestState {
  sourceThreadId: string;
  documentId: string;
  senderRelationship: string;
  throwAfterUpsert?: boolean;
}

function traceFixture(senderRelationship: string): SenderExtractionEvent {
  return {
    fromKind: "unknown",
    bodyActor: null,
    effectiveAuthor: "unknown",
    botSlug: null,
    parserHit: null,
    senderAddress: null,
    senderDomain: null,
    persona: null,
    senderPriorKey: null,
    senderPriorCounts: {},
    knownContact: false,
    senderRelationship,
    senderKind: null,
    senderKindConfidence: null,
    senderKindEvidenceCodes: [],
    senderKindDemotedPersonTreatment: false,
    senderKindDemotedCategory: false,
    senderKindDemotionReason: null,
    meetingDemotedCategory: false,
    meetingDemotionReason: null,
    threadMessages: 1,
    threadNewest: "received",
    gmailImportant: false,
    gmailCategories: [],
    contentFlags: {
      hasUnsubscribe: false,
      hasCurrencyAmount: false,
      hasSecurityKeyword: false,
      hasCalendarInvite: false,
      hasInvestorNotice: false,
      hasPublicEventLanguage: false,
    },
    firstPassCategory: null,
    firstPassConfidence: null,
    firstPassCollabActivity: null,
    conflict: null,
    secondPassCategory: null,
    secondPassCollabActivity: null,
    secondPassFailure: null,
    floorMatched: false,
    floorForced: false,
    finalCategory: "fyi",
    finalConfidence: 0.5,
    finalCollabActivity: null,
    todoSuggested: false,
    standingInstructionSuppressedTodo: false,
    standingInstructionFactId: null,
    standingInstructionEffect: null,
    standingInstructionReadFailed: false,
    todoOutcome: null,
    todoNote: null,
  };
}

function decisionTraceWorkflow(slug: string): Workflow<TestState> {
  return {
    slug,
    name: "decision trace store test",
    trigger: { kind: "manual" },
    initialState: () => ({
      sourceThreadId: "thread_unused",
      documentId: "doc_unused",
      senderRelationship: "unused",
    }),
    initialStep: "classify",
    steps: {
      classify: {
        id: "classify",
        run: async (ctx): Promise<StepResult<TestState>> => {
          const trace = traceFixture(ctx.state.senderRelationship);
          await upsertTriage({
            userId: ctx.userId,
            sourceThreadId: ctx.state.sourceThreadId,
            documentId: ctx.state.documentId,
            category: "fyi",
            confidence: 0.5,
            rationale: "test classification",
            model: "test-model",
            runId: ctx.runId,
            decisionTrace: {
              stepId: "classify",
              attempt: ctx.attempt,
              kind: "triage.classification",
              trace,
            },
            authoredAt: new Date("2026-06-27T00:00:00.000Z"),
          });
          if (ctx.state.throwAfterUpsert) {
            throw new Error("boom after canonical row write");
          }
          ctx.trace("triage.classification", trace);
          return { kind: "done", state: ctx.state, output: { ok: true } };
        },
      },
    },
  };
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Trace Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedRunnableRun(args: {
  userId: string;
  workflowSlug: string;
  state: TestState;
}): Promise<string> {
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db().insert(agentRuns).values({
    id: runId,
    userId: args.userId,
    workflowSlug: args.workflowSlug,
    currentStep: "classify",
    status: "runnable",
    attempt: 0,
    state: args.state,
    lastCheckpointAt: new Date(),
  });
  return runId;
}

async function seedGmailDocument(args: {
  userId: string;
  sourceThreadId: string;
  authoredAt: Date;
}): Promise<string> {
  const id = `doc_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(documents)
    .values({
      id,
      userId: args.userId,
      source: "gmail",
      sourceId: `msg_${randomUUID()}`,
      sourceThreadId: args.sourceThreadId,
      title: "Decision trace test message",
      content: "fixture",
      contentHash: `hash_${randomUUID()}`,
      authoredAt: args.authoredAt,
      metadata: {},
    });
  return id;
}

async function traceRows(runId: string) {
  return await db()
    .select({
      userId: agentDecisionTraces.userId,
      workflowSlug: agentDecisionTraces.workflowSlug,
      stepId: agentDecisionTraces.stepId,
      attempt: agentDecisionTraces.attempt,
      kind: agentDecisionTraces.kind,
      decisionKey: agentDecisionTraces.decisionKey,
      trace: agentDecisionTraces.trace,
    })
    .from(agentDecisionTraces)
    .where(eq(agentDecisionTraces.runId, runId));
}

describe("triage decision trace persistence (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    await closeConnections();
  });

  test("row-atomic upsert trace plus ctx.trace leaves exactly one keyed trace", async () => {
    const userId = await seedUser();
    const workflowSlug = `${ID_PREFIX}success-${randomUUID().slice(0, 8)}`;
    registerWorkflow(decisionTraceWorkflow(workflowSlug));
    const state: TestState = {
      sourceThreadId: `thread_${randomUUID()}`,
      documentId: `doc_${randomUUID()}`,
      senderRelationship: "strong two-way",
    };
    const runId = await seedRunnableRun({ userId, workflowSlug, state });

    const outcome = await runOnce(runId);
    assert.equal(outcome.kind, "completed");

    const rows = await traceRows(runId);
    assert.equal(rows.length, 1, "store insert and executor ctx.trace must dedupe");
    assert.equal(rows[0]?.userId, userId, "trace user is derived from the run row");
    assert.equal(rows[0]?.workflowSlug, workflowSlug, "trace workflow is derived from the run row");
    assert.equal(rows[0]?.stepId, "classify");
    assert.equal(rows[0]?.attempt, 0);
    assert.equal(rows[0]?.decisionKey, "default");
    assert.equal(
      (rows[0]?.trace as SenderExtractionEvent | undefined)?.senderRelationship,
      "strong two-way",
    );
  });

  test("a step failure after upsert keeps the canonical row and its trace together", async () => {
    const userId = await seedUser();
    const workflowSlug = `${ID_PREFIX}failure-${randomUUID().slice(0, 8)}`;
    registerWorkflow(decisionTraceWorkflow(workflowSlug));
    const state: TestState = {
      sourceThreadId: `thread_${randomUUID()}`,
      documentId: `doc_${randomUUID()}`,
      senderRelationship: "weak one-way",
      throwAfterUpsert: true,
    };
    const runId = await seedRunnableRun({ userId, workflowSlug, state });

    const outcome = await runOnce(runId);
    assert.equal(outcome.kind, "failed");

    const tags = await db()
      .select({ category: emailTriage.category, documentId: emailTriage.documentId })
      .from(emailTriage)
      .where(
        and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, state.sourceThreadId)),
      );
    assert.equal(tags.length, 1, "canonical triage row committed before the step failed");
    assert.equal(tags[0]?.documentId, state.documentId);

    const rows = await traceRows(runId);
    assert.equal(rows.length, 1, "trace committed with the canonical row despite step failure");
    assert.equal(
      (rows[0]?.trace as SenderExtractionEvent | undefined)?.senderRelationship,
      "weak one-way",
    );
  });

  test("a recency-loser upsert does not write a stale decision trace", async () => {
    const userId = await seedUser();
    const workflowSlug = `${ID_PREFIX}recency-${randomUUID().slice(0, 8)}`;
    const sourceThreadId = `thread_${randomUUID()}`;
    const newerDocId = await seedGmailDocument({
      userId,
      sourceThreadId,
      authoredAt: new Date("2026-06-27T10:00:00.000Z"),
    });
    const olderDocId = await seedGmailDocument({
      userId,
      sourceThreadId,
      authoredAt: new Date("2026-06-27T09:00:00.000Z"),
    });
    const runId = await seedRunnableRun({
      userId,
      workflowSlug,
      state: {
        sourceThreadId,
        documentId: olderDocId,
        senderRelationship: "older message",
      },
    });

    await db()
      .insert(emailTriage)
      .values({
        userId,
        sourceThreadId,
        documentId: newerDocId,
        category: "action_needed",
        confidence: 0.9,
        rationale: "newer message owns the row",
        model: "test-model",
        runId: `run_existing_${randomUUID().slice(0, 8)}`,
        source: "auto",
        classifiedAt: new Date("2026-06-27T10:01:00.000Z"),
      });

    const result = await upsertTriage({
      userId,
      sourceThreadId,
      documentId: olderDocId,
      category: "fyi",
      confidence: 0.5,
      rationale: "older message lost the race",
      model: "test-model",
      runId,
      decisionTrace: {
        stepId: "classify",
        attempt: 0,
        kind: "triage.classification",
        trace: traceFixture("stale older message"),
      },
      authoredAt: new Date("2026-06-27T09:00:00.000Z"),
    });

    assert.equal(result.written, false, "older message must not become the canonical row");
    assert.equal(result.row.documentId, newerDocId);
    assert.equal(result.row.category, "action_needed");
    assert.equal((await traceRows(runId)).length, 0, "recency loser writes no stale trace");
  });

  test("a mismatched run owner rolls back the row write and trace", async () => {
    const rowUserId = await seedUser();
    const runUserId = await seedUser();
    const runId = await seedRunnableRun({
      userId: runUserId,
      workflowSlug: `${ID_PREFIX}mismatch-${randomUUID().slice(0, 8)}`,
      state: {
        sourceThreadId: "unused",
        documentId: "unused",
        senderRelationship: "unused",
      },
    });
    const sourceThreadId = `thread_${randomUUID()}`;

    await assert.rejects(
      upsertTriage({
        userId: rowUserId,
        sourceThreadId,
        documentId: `doc_${randomUUID()}`,
        category: "fyi",
        confidence: 0.5,
        rationale: "test classification",
        model: "test-model",
        runId,
        decisionTrace: {
          stepId: "classify",
          attempt: 0,
          kind: "triage.classification",
          trace: traceFixture("mismatched run"),
        },
        authoredAt: null,
      }),
      /decision trace run mismatch/,
    );

    const tags = await db()
      .select({ sourceThreadId: emailTriage.sourceThreadId })
      .from(emailTriage)
      .where(
        and(eq(emailTriage.userId, rowUserId), eq(emailTriage.sourceThreadId, sourceThreadId)),
      );
    assert.equal(tags.length, 0, "mismatched trace aborts the triage row transaction");
    assert.equal((await traceRows(runId)).length, 0, "no mismatched trace row is persisted");
  });

  test("a decision trace without a run id rolls back the row write", async () => {
    const userId = await seedUser();
    const sourceThreadId = `thread_${randomUUID()}`;

    await assert.rejects(
      upsertTriage({
        userId,
        sourceThreadId,
        documentId: `doc_${randomUUID()}`,
        category: "fyi",
        confidence: 0.5,
        rationale: "test classification",
        model: "test-model",
        runId: null,
        decisionTrace: {
          stepId: "classify",
          attempt: 0,
          kind: "triage.classification",
          trace: traceFixture("missing run"),
        },
        authoredAt: null,
      }),
      /decision trace requires a run id/,
    );

    const tags = await db()
      .select({ sourceThreadId: emailTriage.sourceThreadId })
      .from(emailTriage)
      .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));
    assert.equal(tags.length, 0, "missing run id aborts the triage row transaction");
  });
});

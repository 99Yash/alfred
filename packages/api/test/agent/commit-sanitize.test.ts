import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { AgentTranscriptMessage } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { agentDecisionTraces, agentRuns, pendingActions, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import { runOnce } from "../../src/modules/agent/executor";
import {
  _resetRegistryForTests,
  getWorkflow,
  registerWorkflow,
} from "../../src/modules/agent/registry";
import type { StepResult, Workflow } from "../../src/modules/agent/types";
import type { SenderExtractionEvent } from "../../src/modules/triage";

/**
 * DB-backed regression for the ADR-0070 §1.1/§1.3 executor-sink gap (PR review
 * P1): `commitStepSuccess` writes `agent_runs.state`, `.transcript`, the
 * step/run `output`, and staged action payloads into jsonb. Model-derived
 * poison (U+0000 / a lone surrogate) reaches those sinks via the replayed
 * transcript even though the dispatch-boundary sanitizer never saw it. Before
 * the fix the jsonb write threw *after* the chat row was already persisted
 * `complete`, leaving the run stuck `running` → reclaim/backstop (the exact
 * split ADR-0072 kills). The executor must strip every sink before commit.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Written with the `\x00` ESCAPE form, never a
 * literal NUL byte (a literal one turns this file binary to rg/grep/git).
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800); // unpaired high surrogate
const ID_PREFIX = "test-commit-sanitize-";
const SLUG = "__test-commit-sanitize";
const createdUserIds: string[] = [];

interface TestState {
  marker: string;
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
    conflict: null,
    secondPassCategory: null,
    secondPassFailure: null,
    floorMatched: false,
    floorForced: false,
    finalCategory: "fyi",
    finalConfidence: 0.5,
    todoSuggested: false,
    standingInstructionSuppressedTodo: false,
    standingInstructionFactId: null,
    standingInstructionEffect: null,
    standingInstructionReadFailed: false,
    todoOutcome: null,
    todoNote: null,
  };
}

/**
 * Two-step workflow whose every jsonb sink carries poison: `next` (state +
 * transcript + a staged action payload), then `done` (state + output +
 * transcript). If the executor doesn't strip, the commit throws on the jsonb
 * write and `runOnce` rejects instead of advancing/completing.
 */
const poisonWorkflow: Workflow<TestState> = {
  slug: SLUG,
  name: "commit-sanitize test",
  trigger: { kind: "manual" },
  initialState: () => ({ marker: "init" }),
  initialStep: "poison-next",
  steps: {
    "poison-next": {
      id: "poison-next",
      run: async (ctx): Promise<StepResult<TestState>> => {
        ctx.stageAction({
          kind: "test.noop",
          payload: { body: `staged${NUL}payload`, nested: { x: `s${LONE_SURROGATE}` } },
          idempotencyKey: `${ctx.runId}:staged`,
        });
        // Decision-trace sink (#219 PR-A) — same poison-strip path as the others.
        ctx.trace("triage.classification", traceFixture(`rel${NUL}poison`));
        ctx.trace("triage.classification", traceFixture(`secondary${LONE_SURROGATE}poison`), {
          decisionKey: "secondary",
        });
        const transcript: AgentTranscriptMessage[] = [
          { role: "assistant", content: `tool input ${NUL} echoed` },
        ];
        return {
          kind: "next",
          state: { marker: `state${NUL}poison` },
          nextStep: "poison-done",
          transcript,
        };
      },
    },
    "poison-done": {
      id: "poison-done",
      run: async (): Promise<StepResult<TestState>> => {
        const transcript: AgentTranscriptMessage[] = [
          { role: "assistant", content: `final ${LONE_SURROGATE} answer` },
        ];
        return {
          kind: "done",
          state: { marker: `done${NUL}state` },
          output: { messageId: `msg${NUL}id` },
          transcript,
        };
      },
    },
  },
};

async function seedRunnableRun(): Promise<{ userId: string; runId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  const runId = `run_${randomUUID().slice(0, 12)}`;
  await db()
    .insert(agentRuns)
    .values({
      id: runId,
      userId,
      workflowSlug: SLUG,
      currentStep: "poison-next",
      status: "runnable",
      attempt: 0,
      state: { marker: "init" },
      lastCheckpointAt: new Date(),
    });
  return { userId, runId };
}

describe("commit sanitizes executor jsonb sinks (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
    if (!getWorkflow(SLUG)) registerWorkflow(poisonWorkflow);
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    _resetRegistryForTests();
    await closeConnections();
  });

  test("a step returning poisoned state/transcript/staged payload commits clean", async () => {
    const { runId } = await seedRunnableRun();

    // Step 1: `next` with poison in state, transcript, and a staged payload.
    // Pre-fix this rejects on the jsonb write; post-fix it advances.
    const first = await runOnce(runId);
    assert.equal(first.kind, "advanced", "the poisoned `next` commit must succeed, not throw");
    assert.equal(first.kind === "advanced" ? first.nextStep : undefined, "poison-done");

    // The staged payload is stripped (Postgres would have rejected a NUL).
    const staged = await db()
      .select({ payload: pendingActions.payload })
      .from(pendingActions)
      .where(eq(pendingActions.runId, runId));
    const payload = staged[0]?.payload as { body: string; nested: { x: string } } | undefined;
    assert.equal(payload?.body, "stagedpayload", "NUL stripped from staged payload string");
    assert.equal(payload?.nested.x, "s", "lone surrogate stripped from nested staged value");

    // The decision trace is persisted on the `next` commit, keyed to the step,
    // with its jsonb poison stripped (#219 PR-A).
    const tr = await db()
      .select({
        userId: agentDecisionTraces.userId,
        workflowSlug: agentDecisionTraces.workflowSlug,
        stepId: agentDecisionTraces.stepId,
        kind: agentDecisionTraces.kind,
        decisionKey: agentDecisionTraces.decisionKey,
        trace: agentDecisionTraces.trace,
      })
      .from(agentDecisionTraces)
      .where(eq(agentDecisionTraces.runId, runId));
    assert.equal(
      tr.length,
      2,
      "two same-kind decision traces with distinct keys persist on the next commit",
    );
    const byKey = new Map(tr.map((row) => [row.decisionKey, row]));
    const defaultTrace = byKey.get("default");
    const secondaryTrace = byKey.get("secondary");
    assert.equal(defaultTrace?.kind, "triage.classification", "trace kind discriminator persisted");
    assert.equal(defaultTrace?.workflowSlug, SLUG, "workflowSlug denormalized onto the trace row");
    assert.equal(defaultTrace?.stepId, "poison-next", "trace keyed to the emitting step");
    assert.equal(
      (defaultTrace?.trace as { senderRelationship: string }).senderRelationship,
      "relpoison",
      "NUL stripped from the trace jsonb",
    );
    assert.equal(
      (secondaryTrace?.trace as { senderRelationship: string }).senderRelationship,
      "secondarypoison",
      "lone surrogate stripped from the keyed trace jsonb",
    );

    // Step 2: `done` with poison in state, output, and transcript.
    const second = await runOnce(runId);
    assert.equal(second.kind, "completed", "the poisoned `done` commit must succeed, not throw");

    const rows = await db()
      .select({
        status: agentRuns.status,
        state: agentRuns.state,
        output: agentRuns.output,
        transcript: agentRuns.transcript,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    const row = rows[0];
    assert.equal(row?.status, "completed", "the run reaches terminal success, never stuck running");
    assert.equal(
      (row?.state as TestState).marker,
      "donestate",
      "NUL stripped from committed state",
    );
    assert.equal(
      (row?.output as { messageId: string }).messageId,
      "msgid",
      "NUL stripped from committed output",
    );
    const transcript = row?.transcript as AgentTranscriptMessage[];
    assert.equal(
      transcript[0]?.content,
      "final  answer",
      "lone surrogate stripped from transcript",
    );
  });
});

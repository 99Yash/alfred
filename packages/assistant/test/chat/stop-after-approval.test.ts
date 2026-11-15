import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { isToolName, type ToolName } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { chatThreads, user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

import { closeRedis } from "@alfred/db/redis";
import { chatTurnWorkflow } from "@alfred/assistant/chat/chat-turn";
import type { ChatRunState } from "@alfred/assistant/chat/chat-turn-state";
import { isChatStopRequested, requestChatStop } from "@alfred/assistant/chat/stop-signal";
import type { StepContext } from "@alfred/assistant/execution";
import {
  registerToolCallRoundAdapter,
  registerToolRuntimeAdapter,
  type ToolRuntimeAdapter,
} from "@alfred/assistant/tool-runtime";
import { _setToolRuntimeSpanStarterForTests } from "../../src/tool-runtime/internal/runtime-spans";
import { dbBackedSkip } from "../support/db-backed";
import { FIRST_STEP } from "../support/first-step";

/**
 * SM-08: a Stop pressed during a tool round must not outlive the approval park. The user's
 * approval is the newer decision, so the resumed round dispatches the approved call. A Stop that
 * reaches a sub-agent join park still stops the turn.
 */

const SKIP = dbBackedSkip("database+redis");

const ID_PREFIX = "test-stop-after-approval-";

const TOOL: ToolName = "contacts.search";

const createdUserIds: string[] = [];

type ToolCallRoundAdapter = Parameters<typeof registerToolCallRoundAdapter>[0];

/** A round adapter that executes every call and records which ones it saw. */
async function withExecutingRound<T>(dispatched: string[], fn: () => Promise<T>): Promise<T> {
  const round: ToolCallRoundAdapter = {
    dispatch: async (args) => {
      dispatched.push(args.toolCallId);

      return {
        kind: "executed",
        stagingId: null,
        toolResult: { ok: true },
        effects: {},
        editedByUser: false,
      };
    },
    dispatchUnlessGated: () => Promise.reject(new Error("no waivable call")),
    forecastApproval: () => Promise.resolve("none"),
    readFullAutonomy: () => Promise.resolve(false),
    executionLane: () => null,
    artifactStreamMode: () => null,
  };

  const surface: ToolRuntimeAdapter = {
    restore(source) {
      if (source.kind === "kernel") return [];
      const candidates = source.kind === "exact" ? source.names : source.pendingNames;

      return candidates.filter((name): name is ToolName => isToolName(name) && name === TOOL);
    },
    resolve: () => ({
      tools: {},
      surfacedNames: [],
      loadedNames: [],
      kernelCount: 0,
      schemaBytes: 0,
      schemaTokens: 0,
    }),
    namesForIntegrations: () => [],
    availableToolNamesByIntegration: () => new Map(),
    selectPreload: () => Promise.resolve({ promptChars: 0, selectedNames: [] }),
  };

  const unregisterSurface = registerToolRuntimeAdapter(surface);
  const unregisterRound = registerToolCallRoundAdapter(round);
  const restoreSpanStarter = _setToolRuntimeSpanStarterForTests(() => ({ end() {} }));

  try {
    return await fn();
  } finally {
    restoreSpanStarter();
    unregisterRound();
    unregisterSurface();
  }
}

/** A dispatch step resuming from a park, with one pending call and the Stop flag set. */
async function seedParkedRound(parkKind: "gate" | "join"): Promise<{
  ctx: StepContext<ChatRunState>;
  toolCallId: string;
}> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test", email: `${userId}@example.test` });

  const [thread] = await db()
    .insert(chatThreads)
    .values({ userId, title: "Stop after approval" })
    .returning({ id: chatThreads.id });

  assert.ok(thread);

  const runId = `run_${randomUUID().slice(0, 12)}`;
  const toolCallId = `call_${randomUUID().slice(0, 8)}`;

  const state = chatRunStateOf({
    threadId: thread.id,
    messageId: `msg_${randomUUID().slice(0, 12)}`,
    tier: "standard",
    activeTools: [TOOL],
    allowedIntegrations: [],
    pendingToolCalls: [{ toolCallId, toolName: TOOL, input: {} }],
    timezone: "UTC",
    parkedAt: new Date().toISOString(),
    parkKind,
  });

  assert.equal(await requestChatStop(runId), true, "the Stop flag is set before the park");

  return {
    toolCallId,
    ctx: {
      runId,
      userId,
      idempotencyKey: `${runId}:dispatch-tools:0`,
      ...FIRST_STEP,
      state,
      transcript: [],
      log: () => Promise.resolve(),
      trace: () => {},
    },
  };
}

function chatRunStateOf(raw: Record<string, unknown>): ChatRunState {
  const parsed = chatTurnWorkflow.stateSchema?.parse(raw);
  assert.ok(parsed, "the chat workflow declares a state schema");

  return parsed;
}

const dispatchToolsStep = chatTurnWorkflow.steps["dispatch-tools"];

describe("a Stop pressed before an approval park (SM-08, DB/Redis-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
    await closeRedis();
  });

  test("the resumed round dispatches the approved call and clears the flag", async () => {
    assert.ok(dispatchToolsStep);
    const dispatched: string[] = [];

    const { ctx, toolCallId, result } = await withExecutingRound(dispatched, async () => {
      const seeded = await seedParkedRound("gate");

      return { ...seeded, result: await dispatchToolsStep.run(seeded.ctx) };
    });

    assert.equal(result.kind, "next", "the turn continues to answer after the approved call");
    assert.deepEqual(dispatched, [toolCallId]);
    assert.equal(await isChatStopRequested(ctx.runId), false, "the old Stop cannot cut the reply");
  });

  test("a Stop that reaches a sub-agent join park still stops the turn", async () => {
    assert.ok(dispatchToolsStep);
    const dispatched: string[] = [];

    const result = await withExecutingRound(dispatched, async () =>
      dispatchToolsStep.run((await seedParkedRound("join")).ctx),
    );

    assert.equal(result.kind, "done");
    assert.deepEqual(dispatched, []);
  });
});

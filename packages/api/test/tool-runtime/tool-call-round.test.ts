import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isToolName, type ToolName } from "@alfred/contracts";
import {
  executeToolCallRound,
  registerToolCallRoundAdapter,
  registerToolRuntimeAdapter,
  type ProposedToolCall,
  type ToolCallRun,
  type ToolRuntimeAdapter,
} from "@alfred/assistant/tool-runtime";
import { _setToolRuntimeSpanStarterForTests } from "@alfred/assistant/tool-runtime/internal/runtime-spans";

type ToolCallRoundAdapter = Parameters<typeof registerToolCallRoundAdapter>[0];
type ToolCallDispatchResult = Awaited<ReturnType<ToolCallRoundAdapter["dispatch"]>>;

const backgroundRun: ToolCallRun = {
  runId: "run_test",
  stepId: "dispatch-tools",
  userId: "user_test",
  workflow: "test-workflow",
  caller: "boss",
  runContext: { caller: "boss", interaction: "background" },
};

const liveRun: ToolCallRun = {
  ...backgroundRun,
  runContext: { caller: "boss", interaction: "live_chat" },
};

function call(toolCallId: string, toolName: string): ProposedToolCall {
  return { toolCallId, toolName, input: {} };
}

function executed(result: unknown, sanitized = false): ToolCallDispatchResult {
  return {
    kind: "executed",
    stagingId: null,
    toolResult: result,
    editedByUser: false,
    ...(sanitized ? { sanitized: true } : {}),
  };
}

function staged(id: string): ToolCallDispatchResult {
  return {
    kind: "staged",
    stagingId: id,
    wake: { kind: "hil", approvalId: id, approvalKind: "action_staging", prompt: `Approve ${id}` },
  };
}

function parked(name: string): ToolCallDispatchResult {
  return { kind: "parked", wake: { kind: "signal", name } };
}

async function withAdapters<T>(
  round: ToolCallRoundAdapter,
  registeredNames: readonly ToolName[],
  fn: () => Promise<T>,
): Promise<T> {
  const names = new Set(registeredNames);
  const surface: ToolRuntimeAdapter = {
    restore(source) {
      if (source.kind === "kernel") return [];
      const candidates = source.kind === "exact" ? source.names : source.pendingNames;
      return [
        ...new Set(
          candidates.filter((name): name is ToolName => isToolName(name) && names.has(name)),
        ),
      ].sort();
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

describe("executeToolCallRound", () => {
  test("an empty background round completes through the public interface", async () => {
    await withAdapters(
      {
        dispatch: () => Promise.reject(new Error("empty rounds do not dispatch")),
        wouldWaitForApproval: () => Promise.resolve(false),
        executionLane: () => null,
      },
      [],
      async () => {
        const outcome = await executeToolCallRound({
          calls: [],
          transcript: [],
          activeNames: [],
          run: backgroundRun,
        });
        assert.deepEqual(outcome, {
          kind: "completed",
          transcript: [],
          calls: [],
          activeNames: [],
          reissue: false,
        });
      },
    );
  });

  test("background calls dispatch and complete in model order", async () => {
    const events: string[] = [];
    await withAdapters(
      {
        dispatch: async (args) => {
          events.push(args.toolCallId);
          return executed({ id: args.toolCallId });
        },
        wouldWaitForApproval: () => Promise.resolve(false),
        executionLane: () => null,
      },
      ["gmail.search"],
      async () => {
        const outcome = await executeToolCallRound({
          calls: [call("a", "gmail.search"), call("b", "gmail.search")],
          transcript: [],
          activeNames: ["gmail.search"],
          run: backgroundRun,
        });
        assert.equal(outcome.kind, "completed");
        if (outcome.kind !== "completed") return;
        assert.deepEqual(events, ["a", "b"]);
        assert.deepEqual(
          outcome.calls.map((item) => item.call.toolCallId),
          ["a", "b"],
        );
        assert.equal(outcome.transcript.length, 2);
      },
    );
  });

  test("live-chat shared lanes serialize while independent calls overlap", async () => {
    const events: string[] = [];
    let releaseLookup!: () => void;
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    await withAdapters(
      {
        dispatch: async (args) => {
          events.push(`start:${args.toolCallId}`);
          if (args.toolCallId === "lookup") await lookupReleased;
          await Promise.resolve();
          events.push(`end:${args.toolCallId}`);
          return executed({ id: args.toolCallId });
        },
        wouldWaitForApproval: () => Promise.resolve(false),
        executionLane: (name) => (name.startsWith("system.append_artifact") ? "artifact" : null),
      },
      ["system.web_search", "system.append_artifact_section"],
      async () => {
        const pending = executeToolCallRound({
          calls: [
            call("lookup", "system.web_search"),
            call("section-1", "system.append_artifact_section"),
            call("section-2", "system.append_artifact_section"),
          ],
          transcript: [],
          activeNames: ["system.web_search", "system.append_artifact_section"],
          run: liveRun,
        });
        for (let index = 0; index < 30 && events.length < 5; index += 1) {
          await Promise.resolve();
        }
        assert.deepEqual(events, [
          "start:lookup",
          "start:section-1",
          "end:section-1",
          "start:section-2",
          "end:section-2",
        ]);
        releaseLookup();
        const outcome = await pending;
        assert.equal(outcome.kind, "completed");
      },
    );
  });

  test("one approval wait wins over a child wait and later gated calls stay undispatched", async () => {
    const dispatched: string[] = [];
    await withAdapters(
      {
        dispatch: async (args) => {
          dispatched.push(args.toolCallId);
          if (args.toolCallId === "child") return parked("child-finished");
          return staged(`stage-${args.toolCallId}`);
        },
        wouldWaitForApproval: (_userId, name) => Promise.resolve(name.startsWith("gmail.")),
        executionLane: () => null,
      },
      ["system.await_sub_agent", "gmail.send", "gmail.archive"],
      async () => {
        const outcome = await executeToolCallRound({
          calls: [
            call("child", "system.await_sub_agent"),
            call("send", "gmail.send"),
            call("archive", "gmail.archive"),
          ],
          transcript: [],
          activeNames: ["system.await_sub_agent", "gmail.send", "gmail.archive"],
          run: liveRun,
        });
        assert.equal(outcome.kind, "waiting");
        if (outcome.kind !== "waiting") return;
        assert.equal(outcome.wake.kind, "hil");
        assert.deepEqual(dispatched, ["child", "send"]);
      },
    );
  });

  test("inactive and explicit load effects update the exact surface inside the round", async () => {
    const results = new Map<string, ToolCallDispatchResult>([
      [
        "inactive",
        {
          kind: "inactive_tool",
          result: {
            status: "inactive_tool",
            toolName: "gmail.search",
            message: "activate",
            recovery: { kind: "activate_and_reissue", toolName: "gmail.search" },
          },
        },
      ],
      ["load", executed({ ok: true, name: "calendar.list_events" })],
    ]);
    await withAdapters(
      {
        dispatch: (args) => Promise.resolve(results.get(args.toolCallId)!),
        wouldWaitForApproval: () => Promise.resolve(false),
        executionLane: () => null,
      },
      ["system.load_tool", "gmail.search", "calendar.list_events"],
      async () => {
        const outcome = await executeToolCallRound({
          calls: [call("inactive", "gmail.search"), call("load", "system.load_tool")],
          transcript: [],
          activeNames: ["system.load_tool"],
          run: backgroundRun,
        });
        assert.equal(outcome.kind, "completed");
        if (outcome.kind !== "completed") return;
        assert.deepEqual(outcome.activeNames, [
          "calendar.list_events",
          "gmail.search",
          "system.load_tool",
        ]);
        assert.equal(outcome.reissue, true);
        assert.equal(outcome.calls[0]?.nonExecution, true);
      },
    );
  });

  test("completion facts preserve semantic failure and sanitizer routing", async () => {
    await withAdapters(
      {
        dispatch: (args) =>
          Promise.resolve(
            args.toolCallId === "artifact"
              ? executed({ ok: false, status: "not_found" })
              : executed({ ok: true }, true),
          ),
        wouldWaitForApproval: () => Promise.resolve(false),
        executionLane: () => null,
      },
      ["system.update_artifact", "gmail.search"],
      async () => {
        const outcome = await executeToolCallRound({
          calls: [call("artifact", "system.update_artifact"), call("read", "gmail.search")],
          transcript: [],
          activeNames: ["system.update_artifact", "gmail.search"],
          run: backgroundRun,
        });
        assert.equal(outcome.kind, "completed");
        if (outcome.kind !== "completed") return;
        assert.equal(outcome.calls[0]?.status, "failed");
        assert.equal(outcome.calls[0]?.execution, "completed");
        assert.equal(outcome.calls[1]?.status, "succeeded");
        assert.equal(outcome.calls[1]?.sanitized, true);
      },
    );
  });
});

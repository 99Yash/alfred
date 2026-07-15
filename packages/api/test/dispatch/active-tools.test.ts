import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { z } from "zod";

import { activateTool, migrateActiveTools } from "../../src/modules/agent/tool-surface";
import { chatTurnWorkflow } from "../../src/modules/agent/workflows/chat-turn";
import { userAuthoredBriefWorkflow } from "../../src/modules/agent/workflows/user-authored-brief";
import { _setDispatchTraceSinksForTests, dispatchToolCall } from "../../src/modules/dispatch";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
} from "../../src/modules/tools/registry";

let restoreTraceSinks: (() => void) | undefined;

beforeEach(() => {
  restoreTraceSinks = _setDispatchTraceSinksForTests({
    rejectionRecorder: () => {},
    toolSpanStarter: () => ({ success: () => {}, error: () => {} }),
  });
});

afterEach(() => {
  restoreTraceSinks?.();
  clearToolRegistryForTests();
});

describe("exact active tool dispatch", () => {
  test("registry membership alone cannot execute a tool", async () => {
    let executions = 0;
    registerTool(scratchReadTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      activeTools: [],
    });

    assert.equal(result.kind, "inactive_tool");
    assert.equal(executions, 0);
    if (result.kind !== "inactive_tool") return;
    assert.deepEqual(result.result.recovery, {
      kind: "activate_and_reissue",
      toolName: "system.read_scratch",
    });
  });

  test("an active tool still executes through the existing dispatch path", async () => {
    let executions = 0;
    registerTool(scratchReadTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      activeTools: ["system.read_scratch"],
    });

    assert.equal(result.kind, "executed");
    assert.equal(executions, 1);
  });

  test("workflow allowlists reject before inactive-tool recovery", async () => {
    let executions = 0;
    registerTool(
      liveTool({
        integration: "github",
        action: "search",
        riskTier: "no_risk",
        description: "test GitHub search",
        inputSchema: z.object({}).strict(),
        execute: async () => {
          executions++;
          return { ok: true };
        },
      }),
    );

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "github.search",
      input: {},
      activeTools: [],
      allowedIntegrations: ["calendar"],
    });

    assert.equal(result.kind, "not_allowed");
    assert.equal(executions, 0);
  });

  test("structured recovery activates the exact tool for a subsequent model reissue", async () => {
    let executions = 0;
    registerTool(scratchReadTool(() => executions++));
    let activeTools: Array<"system.read_scratch"> = [];

    const args = { ...baseDispatch, activeTools };
    let result = await dispatchToolCall(args);
    if (result.kind === "inactive_tool") {
      activeTools = activateTool(activeTools, result.result.recovery.toolName).filter(
        (name): name is "system.read_scratch" => name === "system.read_scratch",
      );
    }

    assert.equal(result.kind, "inactive_tool");
    assert.deepEqual(activeTools, ["system.read_scratch"]);
    assert.equal(executions, 0, "the schema-blind call must not execute");

    result = await dispatchToolCall({ ...args, toolCallId: "tc_2", activeTools });
    assert.equal(result.kind, "executed");
    assert.equal(executions, 1);
  });
});

describe("legacy active integration migration", () => {
  test("drops retired and unknown names from persisted exact-tool state", () => {
    registerKernelTools();
    registerTool(scratchReadTool(() => {}));

    assert.deepEqual(
      migrateActiveTools(
        ["system.read_scratch", "system.load_integration", "made.up"],
        undefined,
      ),
      ["system.read_scratch"],
    );
  });

  test("expands legacy integration state into registered exact names", () => {
    registerKernelTools();
    registerTool(scratchReadTool(() => {}));
    registerTool(
      liveTool({
        integration: "github",
        action: "search",
        riskTier: "no_risk",
        description: "test GitHub search",
        inputSchema: z.object({}).strict(),
        execute: async () => ({ ok: true }),
      }),
    );

    assert.deepEqual(migrateActiveTools(undefined, ["github"]), [
      "github.search",
      "system.current_time",
      "system.load_tool",
      "system.search_tools",
    ]);
  });

  test("preserves a registered pending call while resuming legacy state", () => {
    registerKernelTools();
    registerTool(scratchReadTool(() => {}));

    assert.deepEqual(migrateActiveTools(undefined, [], ["system.read_scratch", "made.up"]), [
      "system.current_time",
      "system.load_tool",
      "system.read_scratch",
      "system.search_tools",
    ]);
  });
});

describe("persisted active tool state", () => {
  test("chat terminal-failure parsing tolerates a retired tool name", () => {
    registerTool(scratchReadTool(() => {}));

    const state = chatTurnWorkflow.stateSchema?.parse({
      threadId: "thread_1",
      messageId: "message_1",
      tier: "standard",
      activeTools: ["system.read_scratch", "system.load_integration"],
      allowedIntegrations: [],
      pendingToolCalls: [],
    });

    assert.deepEqual(state?.activeTools, ["system.read_scratch"]);
  });

  test("brief parsing tolerates a retired tool name", () => {
    registerTool(scratchReadTool(() => {}));

    const state = userAuthoredBriefWorkflow.stateSchema?.parse({
      activeTools: ["system.read_scratch", "system.load_integration"],
      allowedIntegrations: [],
      pendingToolCalls: [],
      subAgent: null,
      inFlightTailStart: 0,
      turnCount: 0,
    });

    assert.deepEqual(state?.activeTools, ["system.read_scratch"]);
  });
});

const baseDispatch = {
  runId: "run_1",
  stepId: "dispatch-tools",
  toolCallId: "tc_1",
  toolName: "system.read_scratch",
  input: { key: "shared.test" },
  userId: "user_1",
  caller: "boss" as const,
  timezone: "UTC",
};

function scratchReadTool(onExecute: () => void) {
  return liveTool({
    integration: "system",
    action: "read_scratch",
    riskTier: "no_risk",
    description: "test scratch read",
    inputSchema: z.object({ key: z.string() }).strict(),
    execute: async () => {
      onExecute();
      return { ok: true };
    },
  });
}

function registerKernelTools() {
  registerTool(
    liveTool({
      integration: "system",
      action: "current_time",
      riskTier: "no_risk",
      description: "current time",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  );
  registerTool(
    liveTool({
      integration: "system",
      action: "load_tool",
      riskTier: "no_risk",
      description: "load tool",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  );
  registerTool(
    liveTool({
      integration: "system",
      action: "search_tools",
      riskTier: "no_risk",
      description: "search tools",
      inputSchema: z.object({}).strict(),
      execute: async () => ({}),
    }),
  );
}

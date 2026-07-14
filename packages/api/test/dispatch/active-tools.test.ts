import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { z } from "zod";

import { activateTool, migrateActiveTools } from "../../src/modules/agent/tool-surface";
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
  test("expands legacy integration state into registered exact names", () => {
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
      "system.read_scratch",
    ]);
  });

  test("preserves a registered pending call while resuming legacy state", () => {
    registerTool(scratchReadTool(() => {}));

    assert.deepEqual(migrateActiveTools(undefined, [], ["system.read_scratch", "made.up"]), [
      "system.read_scratch",
    ]);
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

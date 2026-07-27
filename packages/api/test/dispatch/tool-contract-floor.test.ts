import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { z } from "zod";

import { _setDispatchTraceSinksForTests, dispatchToolCall } from "../../src/modules/dispatch";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
} from "../../src/modules/tools/registry";

/**
 * The declared tool contract is enforced at the dispatch floor, by the ONE
 * availability evaluator — not by `if (toolName === …)` branches the dispatcher
 * keeps in step with the registrations by hand. These pin the properties that
 * make that true: a permission declared on the registration is refused at the
 * floor for a tool the dispatcher has never heard of, and the refusal arrives
 * before any input parsing, staging row, or execute.
 *
 * The credential-health half of the same evaluator is covered without a database
 * in `tools/passthrough/availability.test.ts`; here every fixture is a `system.*`
 * tool precisely because those resolve from the registration alone.
 */

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

const baseDispatch = {
  runId: "run_1",
  stepId: "dispatch-tools",
  toolCallId: "tc_1",
  userId: "user_1",
  timezone: "UTC",
};

/** A boss-only tool — the shape of the sub-agent join tools (ADR-0073). */
function bossOnlyTool(onExecute: () => void) {
  return liveTool({
    integration: "system",
    action: "spawn_sub_agent",
    riskTier: "no_risk",
    description: "test boss-only tool",
    availability: { surface: "kernel", callers: ["boss"] },
    staging: "fast_path",
    inputSchema: z.object({}).loose(),
    execute: async () => {
      onExecute();
      return { ok: true };
    },
  });
}

/** A thread-only tool — the shape of `system.read_chat_history`. */
function threadOnlyTool(onExecute: () => void) {
  return liveTool({
    integration: "system",
    action: "read_chat_history",
    riskTier: "no_risk",
    description: "test thread-only tool",
    availability: { surface: "kernel", requiresThread: true },
    staging: "fast_path",
    inputSchema: z.object({}).loose(),
    execute: async () => {
      onExecute();
      return { ok: true };
    },
  });
}

describe("the declared tool contract is enforced at the dispatch floor", () => {
  test("`callers` refuses a boss-only tool called by a sub-agent", async () => {
    let executions = 0;
    registerTool(bossOnlyTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "system.spawn_sub_agent",
      input: {},
      activeTools: ["system.spawn_sub_agent"],
      caller: { subId: "sub_a" },
    });

    assert.equal(result.kind, "not_allowed");
    assert.equal(executions, 0);
    if (result.kind !== "not_allowed") return;
    assert.match(result.result.message, /boss caller/);
  });

  test("`callers` lets the boss through the same tool", async () => {
    let executions = 0;
    registerTool(bossOnlyTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "system.spawn_sub_agent",
      input: {},
      activeTools: ["system.spawn_sub_agent"],
      caller: "boss" as const,
    });

    assert.equal(result.kind, "executed");
    assert.equal(executions, 1);
  });

  test("`requiresThread` refuses a thread-only tool in a thread-less run", async () => {
    let executions = 0;
    registerTool(threadOnlyTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "system.read_chat_history",
      input: {},
      activeTools: ["system.read_chat_history"],
      caller: "boss" as const,
    });

    assert.equal(result.kind, "not_allowed");
    assert.equal(executions, 0);
    if (result.kind !== "not_allowed") return;
    assert.match(result.result.message, /chat thread/);
  });

  test("`requiresThread` lets the same tool through inside a chat thread", async () => {
    let executions = 0;
    registerTool(threadOnlyTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "system.read_chat_history",
      input: {},
      activeTools: ["system.read_chat_history"],
      caller: "boss" as const,
      threadId: "thr_1",
    });

    assert.equal(result.kind, "executed");
    assert.equal(executions, 1);
  });

  test("the refusal lands before input validation, so a bad input still reports the real reason", async () => {
    registerTool(
      liveTool({
        integration: "system",
        action: "promote",
        riskTier: "no_risk",
        description: "test boss-only promote",
        availability: { callers: ["boss"] },
        staging: "fast_path",
        inputSchema: z.object({ fromKey: z.string(), toKey: z.string() }).strict(),
        execute: async () => ({ ok: true }),
      }),
    );

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "system.promote",
      // Input the schema would reject — the caller gate must still win, or the
      // model would be told to fix its arguments for a call it may never make.
      input: { nonsense: true },
      activeTools: ["system.promote"],
      caller: { subId: "sub_a" },
    });

    assert.equal(result.kind, "not_allowed");
    if (result.kind !== "not_allowed") return;
    assert.match(result.result.message, /boss caller/);
  });

  test("an unavailable tool is refused even when it is on the active surface", async () => {
    // The surface is built at turn start and a tool can also be auto-activated by
    // an inactive bounce (#407) without ever passing an availability check, so
    // active-surface membership must not be treated as authorization.
    let executions = 0;
    registerTool(bossOnlyTool(() => executions++));

    const result = await dispatchToolCall({
      ...baseDispatch,
      toolName: "system.spawn_sub_agent",
      input: {},
      activeTools: ["system.spawn_sub_agent"],
      caller: { subId: "sub_a" },
    });

    assert.notEqual(result.kind, "inactive_tool");
    assert.equal(result.kind, "not_allowed");
    assert.equal(executions, 0);
  });
});

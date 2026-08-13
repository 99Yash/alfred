import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { standingInstructionValueSchema } from "@alfred/contracts";
import type { RememberSenderSuppressionResult } from "@alfred/assistant/knowledge";
import type { ResolveTodosForGmailSenderResult } from "@alfred/assistant/tasks";
import type { SystemToolRequest } from "@alfred/assistant/tool-runtime";
import { createRememberSenderSuppressionCoordinator } from "../../src/runtime/adapters/system-tool-product";

const request = {
  input: {
    kind: "sender_suppression",
    senderEmail: "Sender@Example.com",
    senderLabel: "Sender",
  },
  context: {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    toolCallId: "call_1",
  },
} satisfies SystemToolRequest<"system.remember">;

const instruction = standingInstructionValueSchema.parse({
  schemaVersion: 1,
  action: "suppress",
  surface: "open_loop",
  target: {
    kind: "sender_email",
    email: "sender@example.com",
    label: "Sender",
    accountId: null,
  },
  effects: ["block_todo_suggestion", "exclude_briefing_priority"],
  directive: "Do not surface this sender.",
  phrasing: "Ignore this sender.",
});

describe("sender suppression coordinator", () => {
  test("writes the instruction before it dismisses todos", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const remembered: RememberSenderSuppressionResult = {
      ok: true,
      status: "remembered",
      factId: "fact_1",
      instruction,
    };
    const dismissed: ResolveTodosForGmailSenderResult = {
      ok: true,
      status: "dismissed",
      dismissedCount: 1,
      todoIds: ["todo_1"],
      matchedThreadIds: ["thread_1"],
    };
    const coordinate = createRememberSenderSuppressionCoordinator({
      remember: (args) => {
        calls.push({ name: "remember", args });
        return Promise.resolve(remembered);
      },
      dismissTodos: (args) => {
        calls.push({ name: "dismiss", args });
        return Promise.resolve(dismissed);
      },
    });

    assert.deepEqual(await coordinate(request), { ...remembered, resolvedTodos: dismissed });
    assert.deepEqual(calls, [
      {
        name: "remember",
        args: {
          userId: "user_1",
          senderEmail: "Sender@Example.com",
          senderLabel: "Sender",
          accountId: null,
          directive: undefined,
          phrasing: undefined,
          source: {
            kind: "tool_call",
            id: "call_1",
            meta: { runId: "run_1", stepId: "step_1" },
          },
        },
      },
      {
        name: "dismiss",
        args: {
          userId: "user_1",
          senderEmail: "sender@example.com",
          accountId: null,
          reason: "standing_instruction_sender_suppression",
        },
      },
    ]);
  });

  test("returns a clarification unchanged and does not dismiss todos", async () => {
    const clarification: RememberSenderSuppressionResult = {
      ok: false,
      status: "needs_clarification",
      reason: "invalid_sender_email",
      message: "Which sender should I suppress?",
    };
    let dismissCount = 0;
    const coordinate = createRememberSenderSuppressionCoordinator({
      remember: () => Promise.resolve(clarification),
      dismissTodos: () => {
        dismissCount += 1;
        return Promise.resolve({
          ok: true,
          status: "not_found",
          dismissedCount: 0,
          todoIds: [],
          matchedThreadIds: [],
        });
      },
    });

    assert.equal(await coordinate(request), clarification);
    assert.equal(dismissCount, 0);
  });
});

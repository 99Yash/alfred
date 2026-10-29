import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { standingInstructionValueV2Schema } from "@alfred/contracts";
import type { SaveStandingInstructionResult } from "@alfred/assistant/knowledge";
import type { ResolveTodosForGmailSourceResult } from "@alfred/assistant/tasks";
import type { SystemToolRequest } from "@alfred/assistant/tool-runtime";
import { createRememberInstructionCoordinator } from "../../src/runtime/adapters/system-tool-product";

const request = {
  input: {
    kind: "standing_instruction",
    phrasing: "Ignore this sender.",
    directive: "Do not surface this sender.",
    targets: ["sender@example.com"],
    effects: ["block_todo_suggestion", "exclude_briefing_priority"],
  },
  context: {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    toolCallId: "call_1",
  },
} satisfies SystemToolRequest<"system.remember">;

const instruction = standingInstructionValueV2Schema.parse({
  schemaVersion: 2,
  instructionId: "si_1",
  revision: 0,
  phrasing: "Ignore this sender.",
  directive: "Do not surface this sender.",
  targets: [{ kind: "sender_email", email: "sender@example.com", label: null, accountId: null }],
  effects: [{ kind: "block_todo_suggestion" }, { kind: "exclude_briefing_priority" }],
});

describe("standing instruction capture coordinator", () => {
  test("writes the instruction before it dismisses todos", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];

    const remembered: SaveStandingInstructionResult = {
      ok: true,
      status: "remembered",
      factId: "fact_1",
      instruction,
      related: [],
    };

    const dismissed: ResolveTodosForGmailSourceResult = {
      ok: true,
      status: "dismissed",
      dismissedCount: 1,
      todoIds: ["todo_1"],
      matchedThreadIds: ["thread_1"],
      auditReason: "sender_suppressed",
    };

    const coordinate = createRememberInstructionCoordinator({
      save: (args) => {
        calls.push({ name: "save", args });

        return Promise.resolve(remembered);
      },
      dismissTodos: (args, attribution) => {
        calls.push({ name: "dismiss", args: { args, attribution } });

        return Promise.resolve(dismissed);
      },
    });

    assert.deepEqual(await coordinate(request), { ...remembered, resolvedTodos: [dismissed] });
    assert.deepEqual(calls, [
      {
        name: "save",
        args: {
          userId: "user_1",
          input: {
            phrasing: "Ignore this sender.",
            directive: "Do not surface this sender.",
            targets: ["sender@example.com"],
            effects: ["block_todo_suggestion", "exclude_briefing_priority"],
          },
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
          args: { userId: "user_1", target: instruction.targets[0] },
          attribution: {
            actor: "agent",
            runId: "run_1",
            toolCallId: "call_1",
            authority: "instruction",
            authorityRef: { kind: "instruction", id: "fact_1" },
            cause: "sender_suppressed",
          },
        },
      },
    ]);
  });

  test("returns a refusal unchanged and does not dismiss todos", async () => {
    const refusal: SaveStandingInstructionResult = {
      ok: false,
      status: "invalid_sender",
      sender: "gmail.com",
      message: "'gmail.com' is not the domain of one organization.",
    };

    let dismissCount = 0;

    const coordinate = createRememberInstructionCoordinator({
      save: () => Promise.resolve(refusal),
      dismissTodos: () => {
        dismissCount += 1;

        return Promise.resolve({
          ok: true,
          status: "not_found",
          dismissedCount: 0,
          todoIds: [],
          matchedThreadIds: [],
          auditReason: "sender_suppressed",
        });
      },
    });

    assert.equal(await coordinate(request), refusal);
    assert.equal(dismissCount, 0);
  });
});

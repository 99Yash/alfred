import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import { z } from "zod";

import { buildDispatchRejectionTraceInput, type DispatchArgs } from "../../src/modules/dispatch";
import type { RegisteredTool } from "../../src/modules/tools/registry";

const startedAt = new Date("2026-06-29T00:00:00.000Z");

const baseDispatch: DispatchArgs = {
  runId: "run_1",
  stepId: "dispatch-tools",
  toolCallId: "tc_1",
  toolName: "system.fetch_url",
  input: { url: "https://example.com/?token=from-dispatch" },
  userId: "user_1",
  caller: "boss",
};

const redactingTool: RegisteredTool = {
  name: "system.fetch_url" as ToolName,
  integration: "system",
  action: "fetch_url",
  riskTier: "no_risk",
  description: "test redacting tool",
  inputSchema: z.object({ url: z.string() }),
  execute: async () => null,
  redactInput: (input: unknown) => {
    const obj = input as { url: string };
    return { ...obj, url: obj.url.replace(/token=[^&#]*/i, "token=[REDACTED]") };
  },
};

describe("buildDispatchRejectionTraceInput", () => {
  test("normalizes raw undeclared tool names and omits unsafe input", () => {
    const trace = buildDispatchRejectionTraceInput({
      dispatch: {
        ...baseDispatch,
        toolName: "send email to yash@example.com token=super-secret",
        input: { body: "private user content" },
      },
      toolName: "<unknown>",
      outcome: "unknown_tool",
      reason: "Tool is not declared",
      startedAt,
    });

    assert.equal(trace.toolName, "<unknown>");
    assert.equal(trace.candidateToolName, undefined);
    assert.equal(trace.reason, "Tool is not declared");
    assert.equal(trace.signature, "<unknown>:unknown_tool");
    assert.equal(trace.input, undefined);
  });

  test("redacts schema-valid rejected input before it reaches the span sink", () => {
    const trace = buildDispatchRejectionTraceInput({
      dispatch: baseDispatch,
      toolName: "system.fetch_url",
      tool: redactingTool,
      input: { url: "https://example.com/?token=secret&page=2" },
      outcome: "rejected",
      reason: "rejected by user",
      startedAt,
    });

    assert.deepEqual(trace.input, { url: "https://example.com/?token=[REDACTED]&page=2" });
    assert.equal(trace.signature, "system.fetch_url:rejected");
  });

  test("uses the actual rejected payload, not the latest redispatch args", () => {
    const trace = buildDispatchRejectionTraceInput({
      dispatch: {
        ...baseDispatch,
        input: { url: "https://example.com/?token=latest-dispatch" },
      },
      toolName: "system.fetch_url",
      tool: redactingTool,
      input: { url: "https://example.com/?token=stored-row" },
      outcome: "rejected",
      reason: "rejected by user",
      startedAt,
    });

    assert.deepEqual(trace.input, { url: "https://example.com/?token=[REDACTED]" });
  });

  test("keeps schema-failed payloads out of I/O capture when there is no typed redaction path", () => {
    const trace = buildDispatchRejectionTraceInput({
      dispatch: baseDispatch,
      toolName: "system.fetch_url",
      outcome: "invalid_input",
      reason: "Invalid input",
      issues: [{ code: "invalid_type", path: ["url"] }],
      startedAt,
    });

    assert.equal(trace.input, undefined);
    assert.equal(trace.signature, "system.fetch_url:invalid_input:invalid_type@url");
  });
});

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { ToolName } from "@alfred/contracts";
import type { DispatchRejectionInput } from "@alfred/ai";
import { z } from "zod";

import {
  _setDispatchTraceSinksForTests,
  buildDispatchRejectionTraceInput,
  dispatchToolCall,
  type DispatchArgs,
} from "../../src/modules/dispatch";
import {
  clearToolRegistryForTests,
  liveTool,
  registerTool,
  type RegisteredTool,
} from "../../src/modules/tools/registry";

const startedAt = new Date("2026-06-29T00:00:00.000Z");

const baseDispatch: DispatchArgs = {
  runId: "run_1",
  stepId: "dispatch-tools",
  toolCallId: "tc_1",
  toolName: "system.fetch_url",
  input: { url: "https://example.com/?token=from-dispatch" },
  userId: "user_1",
  caller: "boss",
  activeTools: ["system.fetch_url"],
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

afterEach(() => {
  clearToolRegistryForTests();
});

describe("buildDispatchRejectionTraceInput", () => {
  test("normalizes raw undeclared tool names and omits unsafe input", () => {
    const trace = buildDispatchRejectionTraceInput({
      dispatch: {
        ...baseDispatch,
        toolName: "list_events",
        input: { body: "private user content" },
      },
      toolName: "<unknown>",
      candidateToolName: "list_events",
      outcome: "unknown_tool",
      reason: "Tool is not declared",
      startedAt,
    });

    assert.equal(trace.toolName, "<unknown>");
    assert.equal(trace.candidateToolName, "list_events");
    assert.equal(trace.reason, "Tool is not declared");
    assert.equal(trace.signature, "<unknown>:list_events:unknown_tool");
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

describe("dispatchToolCall rejection tracing", () => {
  test("records the undeclared-tool branch with a candidate-specific signature", async () => {
    const captured: DispatchRejectionInput[] = [];
    const restore = _setDispatchTraceSinksForTests({
      rejectionRecorder: (input) => captured.push(input),
    });
    try {
      const result = await dispatchToolCall({
        ...baseDispatch,
        toolName: "list_events",
        input: { timeframe: "today" },
      });

      assert.equal(result.kind, "unknown_tool");
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.toolName, "<unknown>");
      assert.equal(captured[0]?.candidateToolName, "list_events");
      assert.equal(captured[0]?.signature, "<unknown>:list_events:unknown_tool");
      assert.equal(captured[0]?.input, undefined);
    } finally {
      restore();
    }
  });

  test("records the schema-invalid branch from the real dispatcher", async () => {
    registerTool(
      liveTool({
        integration: "system",
        action: "load_tool",
        riskTier: "no_risk",
        description: "test tool",
        inputSchema: z.object({ slug: z.string() }).strict(),
        execute: async () => ({ ok: true }),
      }),
    );
    const captured: DispatchRejectionInput[] = [];
    const restore = _setDispatchTraceSinksForTests({
      rejectionRecorder: (input) => captured.push(input),
    });
    try {
      const result = await dispatchToolCall({
        ...baseDispatch,
        toolName: "system.load_tool",
        input: { slug: 42 },
        activeTools: ["system.load_tool"],
      });

      assert.equal(result.kind, "invalid_input");
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.toolName, "system.load_tool");
      assert.equal(captured[0]?.outcome, "invalid_input");
      assert.equal(captured[0]?.signature, "system.load_tool:invalid_input:invalid_type@slug");
      assert.equal(captured[0]?.input, undefined);
    } finally {
      restore();
    }
  });

  test("records registered-but-inactive calls distinctly from schema failures", async () => {
    registerTool(redactingTool);
    const captured: DispatchRejectionInput[] = [];
    const restore = _setDispatchTraceSinksForTests({
      rejectionRecorder: (input) => captured.push(input),
    });
    try {
      const result = await dispatchToolCall({
        ...baseDispatch,
        activeTools: [],
      });

      assert.equal(result.kind, "inactive_tool");
      assert.equal(captured.length, 1);
      assert.equal(captured[0]?.outcome, "inactive_tool");
      assert.equal(captured[0]?.signature, "system.fetch_url:inactive_tool");
      assert.equal(captured[0]?.input, undefined);
    } finally {
      restore();
    }
  });

  test("opens a tool span for await_sub_agent even though the dispatcher intercepts it", async () => {
    registerTool(
      liveTool({
        integration: "system",
        action: "await_sub_agent",
        riskTier: "no_risk",
        description: "test await tool",
        inputSchema: z.object({ childRunId: z.string() }).strict(),
        execute: async () => {
          throw new Error("await_sub_agent execute should be intercepted");
        },
      }),
    );
    const starts: string[] = [];
    const completions: string[] = [];
    const restore = _setDispatchTraceSinksForTests({
      toolSpanStarter: (input) => {
        starts.push(input.toolName);
        return {
          success: () => completions.push("success"),
          error: () => completions.push("error"),
        };
      },
    });
    try {
      await dispatchToolCall({
        ...baseDispatch,
        toolName: "system.await_sub_agent",
        input: { childRunId: "run_missing_child" },
        activeTools: ["system.await_sub_agent"],
        timezone: "UTC",
      }).catch(() => null);

      assert.deepEqual(starts, ["system.await_sub_agent"]);
      assert.equal(completions.length, 1);
      assert.match(completions[0] ?? "", /^(success|error)$/);
    } finally {
      restore();
    }
  });
});

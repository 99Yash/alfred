import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import {
  CONTEXT_SEARCH_DEFAULT_LIMIT,
  isRecord,
  parseIanaTimezone,
  type EvidenceCard,
} from "@alfred/contracts";
import { registerContextSource } from "@alfred/assistant/context-search";
import {
  executeToolCallRound,
  registerToolCallRoundAdapter,
  runContextSearch,
  type ProposedToolCall,
  type SystemToolRequest,
  type ToolCallRun,
} from "@alfred/assistant/tool-runtime";

import { getTool } from "../../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";
import { toolExecuteContext } from "../../../src/tool-runtime/context";
import { _setToolRuntimeSpanStarterForTests } from "../../../src/tool-runtime/internal/runtime-spans";
import {
  registerSystemToolContextSearch,
  unregisterSystemToolContextSearch,
} from "../../../src/runtime/adapters/system-tool-context-search";

/**
 * Behavioral coverage for the model-facing `system.search_context` tool (#426):
 * its registration and bounded schema, the typed `SystemToolContextSearchAdapter`
 * seam running the real boundary and packer against a fixture source, and one
 * real tool-call round that reads the `{status:"executed", result}` wrapper the
 * chat turn hands the model. A fake source keeps the test off the database while
 * still exercising tool -> seam -> `searchContext` -> `packEvidenceCards`.
 */

const SOURCE_ID = "test:search-context";

const CONTEXT = {
  runId: "run_1",
  scratchpadRunId: "run_1",
  stepId: "step_1",
  toolCallId: "call_1",
  userId: "user_1",
  timezone: parseIanaTimezone("UTC"),
  caller: "boss" as const,
  runContext: { caller: "boss" as const, interaction: "live_chat" as const },
};

const ROUND_RUN: ToolCallRun = {
  runId: "run_1",
  stepId: "dispatch-tools",
  userId: "user_1",
  workflow: "test-workflow",
  caller: "boss",
  runContext: { caller: "boss", interaction: "live_chat" },
  fence: { generation: 0 },
};

function evidenceCard(snippet: string): EvidenceCard {
  return {
    id: `${SOURCE_ID}:1`,
    source: { id: SOURCE_ID, kind: "internal", displayName: "Test source" },
    mediaKind: "text",
    snippet,
    citations: [{ label: "Test citation", locator: "chunk 1" }],
  };
}

/** The exact parsed request `tool.execute` forwards to the seam. */
function seamRequest(query: string): SystemToolRequest<"system.search_context"> {
  return {
    input: { query, limit: CONTEXT_SEARCH_DEFAULT_LIMIT },
    context: {
      userId: CONTEXT.userId,
      runId: CONTEXT.runId,
      stepId: CONTEXT.stepId,
      toolCallId: CONTEXT.toolCallId,
    },
  };
}

describe("system.search_context", () => {
  let disposeSource: (() => void) | undefined;
  let restoreSpanStarter: (() => void) | undefined;

  before(() => {
    registerBuiltinTools();
    registerSystemToolContextSearch();
    restoreSpanStarter = _setToolRuntimeSpanStarterForTests(() => ({ end() {} }));
  });

  after(() => {
    restoreSpanStarter?.();
    unregisterSystemToolContextSearch();
  });

  afterEach(() => {
    disposeSource?.();
    disposeSource = undefined;
  });

  test("registers as a read-only kernel system tool", () => {
    const tool = getTool("system.search_context");
    assert.ok(tool, "system.search_context must be registered at boot");
    assert.equal(tool.integration, "system");
    assert.equal(tool.riskTier, "no_risk");
    assert.equal(tool.staging, "fast_path");
    assert.equal(tool.availability?.surface, "kernel");
  });

  test("shows the model a bounded envelope derived from the boundary request", () => {
    const tool = getTool("system.search_context");
    assert.ok(tool);

    // Unknown keys are refused, so a stray envelope field bounces before any
    // source runs rather than being silently ignored.
    assert.equal(
      tool.modelInputSchema.safeParse({ query: "anything", userId: "user_1" }).success,
      false,
    );
    assert.equal(tool.modelInputSchema.safeParse({}).success, false);
    assert.equal(tool.modelInputSchema.safeParse({ query: "" }).success, false);
    assert.equal(
      tool.modelInputSchema.safeParse({ query: "q", limit: 51 }).success,
      false,
      "the limit must not exceed the boundary cap",
    );

    const parsed = tool.modelInputSchema.safeParse({ query: "  roadmap  " });
    assert.ok(parsed.success);
    // The boundary's trim and default survive the derive.
    assert.deepEqual(parsed.data, { query: "roadmap", limit: 10 });
  });

  test("returns packed evidence text on a representative call", async () => {
    disposeSource = registerContextSource({
      id: SOURCE_ID,
      async search() {
        return { evidence: [evidenceCard("The contract clause is section 12.")] };
      },
    });

    const result = await runContextSearch(seamRequest("contract clause"));

    assert.equal(result.ok, true);
    assert.equal(result.includedCount, 1);
    assert.equal(result.truncated, false);
    assert.match(result.text, /The contract clause is section 12\./);
    assert.match(result.text, /Test source/);
    assert.match(result.text, /Test citation/);
  });

  test("reports an empty read honestly without failing the call", async () => {
    disposeSource = registerContextSource({
      id: SOURCE_ID,
      async search() {
        return { evidence: [] };
      },
    });

    const result = await runContextSearch(seamRequest("nothing matches"));

    assert.equal(result.ok, true);
    assert.equal(result.includedCount, 0);
    // An empty source is reported by name, not swallowed — the model learns the
    // read happened and found nothing rather than seeing a bare "no results".
    assert.match(result.text, /no evidence found/);
  });

  test("turns a failing source into an honest note, not a thrown call", async () => {
    disposeSource = registerContextSource({
      id: SOURCE_ID,
      async search() {
        throw new Error("provider exploded");
      },
    });

    const result = await runContextSearch(seamRequest("anything"));

    assert.equal(result.ok, true);
    assert.match(result.text, /unavailable/);
  });

  test("wraps the packed result for the model through a real tool-call round", async () => {
    disposeSource = registerContextSource({
      id: SOURCE_ID,
      async search() {
        return { evidence: [evidenceCard("The contract clause is section 12.")] };
      },
    });

    const tool = getTool("system.search_context");
    assert.ok(tool);

    const unregisterRound = registerToolCallRoundAdapter({
      dispatch: async ({ input }) => ({
        kind: "executed",
        stagingId: null,
        toolResult: await tool.execute(input, toolExecuteContext(CONTEXT)),
        editedByUser: false,
      }),
      wouldWaitForApproval: () => Promise.resolve(false),
      executionLane: () => null,
    });

    try {
      const call: ProposedToolCall = {
        toolCallId: "call_1",
        toolName: "system.search_context",
        input: { query: "contract clause" },
      };

      const outcome = await executeToolCallRound({
        calls: [call],
        transcript: [],
        activeNames: ["system.search_context"],
        run: ROUND_RUN,
      });

      assert.equal(outcome.kind, "completed");

      if (outcome.kind !== "completed") return;

      const [message] = outcome.transcript;
      assert.ok(message && message.role === "tool");

      const content: unknown = message.content;
      assert.ok(Array.isArray(content));
      const part: unknown = content[0];
      assert.ok(isRecord(part));
      assert.equal(part.type, "tool-result");
      assert.equal(part.toolName, "system.search_context");

      // The wrapper the chat turn actually persists: `{status:"executed", result}`
      // with the packed result bounded inside it.
      assert.ok(isRecord(part.output));
      assert.equal(part.output.type, "json");
      assert.ok(isRecord(part.output.value));
      assert.equal(part.output.value.status, "executed");
      assert.ok(isRecord(part.output.value.result));
      assert.equal(part.output.value.result.ok, true);
      assert.match(
        String(part.output.value.result.text ?? ""),
        /The contract clause is section 12\./,
      );
    } finally {
      unregisterRound();
    }
  });
});

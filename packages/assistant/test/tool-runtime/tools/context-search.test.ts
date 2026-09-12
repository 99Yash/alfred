import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

import { parseIanaTimezone, type EvidenceCard } from "@alfred/contracts";
import { registerContextSource } from "@alfred/assistant/context-search";

import { getTool } from "../../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";
import { toolExecuteContext } from "../../../src/tool-runtime/context";
import {
  registerSystemToolContextSearch,
  unregisterSystemToolContextSearch,
} from "../../../src/runtime/adapters/system-tool-context-search";

/**
 * Behavioral coverage for the model-facing `system.search_context` tool (#426):
 * its registration and bounded schema, and a representative call through the
 * `SystemToolContextSearchAdapter` seam that runs the real boundary and packer
 * against a fixture source. A fake source keeps the test off the database while
 * still exercising the tool -> seam -> `searchContext` -> `packEvidenceCards`
 * path the chat turn runs.
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

function evidenceCard(snippet: string): EvidenceCard {
  return {
    id: `${SOURCE_ID}:1`,
    source: { id: SOURCE_ID, kind: "internal", displayName: "Test source" },
    mediaKind: "text",
    snippet,
    citations: [{ label: "Test citation", locator: "chunk 1" }],
  };
}

describe("system.search_context", () => {
  let disposeSource: (() => void) | undefined;

  before(() => {
    registerBuiltinTools();
    registerSystemToolContextSearch();
  });

  after(() => {
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

    const tool = getTool("system.search_context");
    assert.ok(tool);

    const result = (await tool.execute(
      { query: "contract clause" },
      toolExecuteContext(CONTEXT),
    )) as {
      ok: boolean;
      text: string;
      includedCount: number;
      truncated: boolean;
    };

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

    const tool = getTool("system.search_context");
    assert.ok(tool);

    const result = (await tool.execute(
      { query: "nothing matches" },
      toolExecuteContext(CONTEXT),
    )) as { ok: boolean; text: string; includedCount: number };

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

    const tool = getTool("system.search_context");
    assert.ok(tool);

    const result = (await tool.execute({ query: "anything" }, toolExecuteContext(CONTEXT))) as {
      ok: boolean;
      text: string;
    };

    assert.equal(result.ok, true);
    assert.match(result.text, /unavailable/);
  });
});

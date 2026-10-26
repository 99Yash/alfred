import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getPath, parseIanaTimezone } from "@alfred/contracts";

import { getTool } from "../../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";
import { toolExecuteContext } from "../../../src/tool-runtime/context";
import type { Corpus, ModelFacingHit } from "@alfred/corpus";
import { executeTool } from "../../support/execute-tool";

describe("system.corpus_search", () => {
  const tool = (() => {
    registerBuiltinTools();
    const found = getTool("system.corpus_search");
    assert.ok(found, "system.corpus_search must be registered at boot");

    return found;
  })();

  test("is a read-only fast-path system tool, discovered via the ladder", () => {
    assert.equal(tool.integration, "system");
    assert.equal(tool.riskTier, "no_risk");
    assert.equal(tool.staging, "fast_path");
    assert.equal(tool.availability?.surface, undefined);
  });

  test("routes the query through the user-bound corpus and returns its hits", async () => {
    const hit: ModelFacingHit = {
      chunkId: "chk_1",
      documentId: "doc_1",
      source: "gmail_attachment",
      title: "resume.pdf",
      position: 0,
      page: 2,
      preview: "Led the platform team…",
      similarity: 0.81,
      authoredAt: new Date("2026-08-01T00:00:00Z"),
    };

    const seen: Parameters<Corpus["search"]>[0][] = [];

    const ctx = {
      ...toolExecuteContext({
        runId: "run_1",
        scratchpadRunId: "run_1",
        stepId: "step_1",
        toolCallId: "call_1",
        userId: "user_1",
        timezone: parseIanaTimezone("UTC"),
        caller: "boss" as const,
        runContext: { caller: "boss" as const, interaction: "background" as const },
        activeTools: [],
      }),
      corpus: {
        search: async (args) => {
          seen.push(args);

          return [hit];
        },
      } satisfies Corpus,
    };

    const result = await executeTool(tool, { query: "resume platform team" }, ctx);

    // The tool passes no user: the bind in `toolExecuteContext` owns it.
    assert.deepEqual(seen, [{ query: "resume platform team" }]);
    assert.equal(getPath(result, "ok"), true);
    assert.equal(getPath(result, "query"), "resume platform team");
    assert.deepEqual(getPath(result, "hits"), [hit]);
  });

  test("passes an empty result through as a valid answer", async () => {
    const ctx = {
      ...toolExecuteContext({
        runId: "run_1",
        scratchpadRunId: "run_1",
        stepId: "step_1",
        toolCallId: "call_1",
        userId: "user_1",
        timezone: parseIanaTimezone("UTC"),
        caller: "boss" as const,
        runContext: { caller: "boss" as const, interaction: "background" as const },
        activeTools: [],
      }),
      corpus: {
        search: async () => [],
      } satisfies Corpus,
    };

    const result = await executeTool(tool, { query: "nothing matches" }, ctx);

    assert.equal(getPath(result, "ok"), true);
    assert.deepEqual(getPath(result, "hits"), []);
  });
});

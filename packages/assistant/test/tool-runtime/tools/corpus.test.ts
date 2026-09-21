import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseIanaTimezone } from "@alfred/contracts";

import { getTool } from "../../../src/tool-runtime/internal/registry";
import { registerBuiltinTools } from "../../../src/tool-runtime/builtin-tools";
import { toolExecuteContext } from "../../../src/tool-runtime/context";
import type { SearchArgs, SearchHit } from "@alfred/corpus";
import type { ModelFacingHit } from "@alfred/corpus";

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

  test("routes the query through the injected corpus bind, bound to the call's user", async () => {
    const hit: SearchHit = {
      chunkId: "chk_1",
      documentId: "doc_1",
      source: "gmail_attachment",
      record: { sourceId: "msg_1:att_1", sourceThreadId: "thread_1", accountId: "acc_1" },
      title: "resume.pdf",
      position: 0,
      page: 2,
      preview: "Led the platform team…",
      similarity: 0.81,
      authoredAt: new Date("2026-08-01T00:00:00Z"),
    };

    const seen: SearchArgs[] = [];

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
      }),
      corpus: {
        search: async (args: SearchArgs) => {
          seen.push(args);

          return [hit];
        },
      },
    };

    // SAFETY: execute returns unknown; this tool's execute builds
    // `{ ok, query, hits }` above, so narrow to that shape for asserts.
    const result = (await tool.execute({ query: "resume platform team" }, ctx)) as {
      ok: boolean;
      query: string;
      hits: ModelFacingHit[];
    };

    assert.deepEqual(seen, [{ query: "resume platform team", userId: "user_1" }]);
    assert.equal(result.ok, true);
    assert.equal(result.query, "resume platform team");
    // The record identity (#1076) is dereference plumbing for the evidence
    // card, never a tool answer: the hit reaches the model as a
    // `ModelFacingHit`, so `record` is absent here by design.
    assert.ok(result.hits[0] && !("record" in result.hits[0]));
    const { record: _record, ...modelHit } = hit;
    assert.deepEqual(result.hits, [modelHit]);
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
      }),
      corpus: {
        search: async (): Promise<SearchHit[]> => [],
      },
    };

    // SAFETY: execute returns unknown; this tool's execute builds
    // `{ ok, hits }` above, so narrow to that shape for asserts.
    const result = (await tool.execute({ query: "nothing matches" }, ctx)) as {
      ok: boolean;
      hits: unknown[];
    };

    assert.equal(result.ok, true);
    assert.deepEqual(result.hits, []);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildGenerationEndPayload,
  buildGenerationPayload,
  buildTracePayload,
  resolveTraceId,
  resolveTraceName,
  traceTags,
} from "../src/metering/langfuse";
import type { MeteredMeta } from "../src/metering/types";

/**
 * The Langfuse envelope (#216/#226) is the code most likely to regress
 * silently — the fallback smoke proves `api_call_log` reattributes the served
 * model but never asserts the generation model, requestedModel, root I/O
 * mirroring, sessionId, or tags. These cover the pure payload builders so a
 * regression fails here instead of only surfacing in the Langfuse UI.
 */

const baseMeta: MeteredMeta = {
  kind: "llm",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("traceTags", () => {
  test("splits call shape and surface into independent namespaces", () => {
    assert.deepEqual(traceTags({ ...baseMeta, role: "boss", kind: "llm" }), [
      "role:boss",
      "call_kind:llm",
    ]);
  });

  test("normalizes the briefing cost bucket to its llm shape + a cost_kind tag", () => {
    // Both briefing call sites (agent kind:'briefing', compose kind:'briefing')
    // must be reachable by a `call_kind:llm` filter, with the cost bucket on a
    // separate dimension (#226 review).
    assert.deepEqual(traceTags({ ...baseMeta, role: "briefing", kind: "briefing" }), [
      "role:briefing",
      "call_kind:llm",
      "cost_kind:briefing",
    ]);
  });

  test("embedding/web_search stay as their own shape with no cost_kind", () => {
    assert.deepEqual(traceTags({ ...baseMeta, kind: "embedding" }), ["call_kind:embedding"]);
    assert.deepEqual(traceTags({ ...baseMeta, kind: "web_search" }), ["call_kind:web_search"]);
  });

  test("returns undefined when neither role nor kind is present", () => {
    // kind is required on MeteredMeta, so exercise the empty path via a cast to
    // the attribution-only shape the builder actually guards against.
    assert.equal(traceTags({ provider: "x", model: "y" } as unknown as MeteredMeta), undefined);
  });
});

describe("resolveTraceId / resolveTraceName", () => {
  test("runId groups calls into one trace tree", () => {
    const meta = { ...baseMeta, runId: "run_123" };
    assert.equal(resolveTraceId(meta), "run_123");
    assert.equal(resolveTraceName(meta), "run:run_123");
  });

  test("ad-hoc calls key off the idempotency key", () => {
    const meta = { ...baseMeta, idempotencyKey: "idem_abc", name: "probe" };
    assert.equal(resolveTraceId(meta), "adhoc:idem_abc");
    assert.equal(resolveTraceName(meta), "probe");
  });

  test("ad-hoc name falls back to provider/model", () => {
    assert.equal(resolveTraceName(baseMeta), "anthropic/claude-sonnet-4-6");
  });
});

describe("buildTracePayload", () => {
  test("sets sessionId only when the caller supplies a real one", () => {
    // Chat passes threadId → grouped session.
    const chat = buildTracePayload({
      meta: { ...baseMeta, runId: "run_1", sessionId: "thread_42" },
      captureIo: false,
    });
    assert.equal(chat.sessionId, "thread_42");

    // Background/job run with no session → sessionless (NOT runId), so the
    // Sessions view isn't polluted with one-trace "sessions" (#226 review).
    const job = buildTracePayload({ meta: { ...baseMeta, runId: "run_1" }, captureIo: false });
    assert.equal(job.sessionId, undefined);
  });

  test("mirrors input to the root only for ad-hoc traces with capture on", () => {
    const adhocOn = buildTracePayload({
      meta: { ...baseMeta, input: "hello" },
      captureIo: true,
    });
    assert.equal(adhocOn.input, "hello");

    // A run trace holds many generations — never mirror one call's input up.
    const runOn = buildTracePayload({
      meta: { ...baseMeta, runId: "run_1", input: "hello" },
      captureIo: true,
    });
    assert.equal(runOn.input, undefined);

    // Capture off → no input regardless of trace shape.
    const adhocOff = buildTracePayload({
      meta: { ...baseMeta, input: "hello" },
      captureIo: false,
    });
    assert.equal(adhocOff.input, undefined);
  });
});

describe("buildGenerationPayload", () => {
  const startedAt = new Date("2026-06-26T00:00:00.000Z");

  test("opens the generation with the requested model and attribution metadata", () => {
    const gen = buildGenerationPayload({
      meta: { ...baseMeta, runId: "run_1", stepId: "step_1", role: "boss", attempt: 2 },
      startedAt,
      captureIo: false,
    });
    assert.equal(gen.traceId, "run_1");
    assert.equal(gen.model, "claude-sonnet-4-6");
    assert.equal(gen.startTime, startedAt);
    assert.equal(gen.input, undefined);
    assert.deepEqual(gen.metadata, {
      kind: "llm",
      role: "boss",
      userId: undefined,
      runId: "run_1",
      stepId: "step_1",
      attempt: 2,
      idempotencyKey: undefined,
    });
  });

  test("attaches input only when capture is on", () => {
    const gen = buildGenerationPayload({
      meta: { ...baseMeta, input: { prompt: "hi" } },
      startedAt,
      captureIo: true,
    });
    assert.deepEqual(gen.input, { prompt: "hi" });
  });
});

describe("buildGenerationEndPayload", () => {
  test("keeps the requested model when the served model is unchanged", () => {
    const end = buildGenerationEndPayload({
      meta: baseMeta,
      costUsd: 0.01,
      servedModel: "claude-sonnet-4-6",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
      responseMeta: { finishReason: "stop" },
      captureIo: false,
    });
    // Unchanged served model → leave generation model untouched (undefined).
    assert.equal(end.model, undefined);
    assert.deepEqual(end.metadata, { finishReason: "stop" });
    assert.deepEqual(end.usage, { input: 10, output: 5, total: 15, unit: "TOKENS" });
    assert.deepEqual(end.usageDetails, { input: 10, output: 5, cached: 2 });
    assert.deepEqual(end.costDetails, { total: 0.01 });
  });

  test("restamps the model and records requestedModel when fallback diverges", () => {
    const end = buildGenerationEndPayload({
      meta: baseMeta,
      costUsd: 0.02,
      servedModel: "gemini-2.5-flash",
      responseMeta: { finishReason: "stop" },
      captureIo: false,
    });
    assert.equal(end.model, "gemini-2.5-flash");
    assert.deepEqual(end.metadata, {
      finishReason: "stop",
      requestedModel: "claude-sonnet-4-6",
    });
  });

  test("attaches output only when capture is on", () => {
    const on = buildGenerationEndPayload({
      meta: baseMeta,
      costUsd: 0,
      output: "the answer",
      captureIo: true,
    });
    assert.equal(on.output, "the answer");

    const off = buildGenerationEndPayload({
      meta: baseMeta,
      costUsd: 0,
      output: "the answer",
      captureIo: false,
    });
    assert.equal(off.output, undefined);
  });
});

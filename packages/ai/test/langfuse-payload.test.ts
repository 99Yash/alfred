import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseOtelSpanAttributes as A } from "@langfuse/tracing";

import {
  _setLangfuseRuntimeForTests,
  buildDispatchRejectionSpanPayload,
  buildGenerationEndPayload,
  buildGenerationPayload,
  buildRuntimeSpanEndPayload,
  buildRuntimeSpanPayload,
  buildTracePayload,
  langfuseTraceId,
  recordDispatchRejection,
  resolveTraceId,
  resolveTraceName,
  startLangfuseSpan,
  startRuntimeSpan,
  startToolSpan,
  traceTags,
} from "../src/metering/langfuse";
import type { MeteredMeta } from "../src/metering/metered";

/**
 * The Langfuse envelope (#216/#226) is the code most likely to regress
 * silently, so this file carries two layers of proof:
 *
 *   1. pure builders — the payload shapes the v5 call sites still consume;
 *   2. a real v5 emission test — the isolated `BasicTracerProvider` exports
 *      through a `LangfuseSpanProcessor` into an in-memory exporter, so the
 *      span name and attributes are asserted end to end (run trace /
 *      generation / tool span / dispatch rejection / runtime span). This is
 *      also where the no-leak guarantee is pinned: the trace attributes must
 *      land on the Langfuse span and never on a non-Langfuse active span.
 *
 * `@langfuse/tracing`'s `propagateAttributes` reads the OTel active context, so
 * the emission tests install the standard context manager the SDK expects.
 */
otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

// `serverEnv()` validates the whole schema on first read, and the span helpers
// call `shouldCaptureIo()`. Seed the required slots so the suite runs with no
// `--env-file` (the CI `ai-unit-tests` job supplies none). Mirrors
// `packages/integrations/test/self-mail-label.test.ts`.
const SERVER_ENV_FIXTURES = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  // #453: `serverEnv()` requires a 32-byte credential KEK in every environment.
  OAUTH_CREDENTIAL_KEK: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <hey@alfred.beauty>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
  ENTITY_ID_NAMESPACE: "stable namespace secret for tests",
} satisfies Record<string, string>;

for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
  process.env[key] ??= value;
}

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
    // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
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
    const chat = buildTracePayload({ ...baseMeta, runId: "run_1", sessionId: "thread_42" });

    assert.equal(chat.sessionId, "thread_42");

    // Background/job run with no session → sessionless (NOT runId), so the
    // Sessions view isn't polluted with one-trace "sessions" (#226 review).
    const job = buildTracePayload({ ...baseMeta, runId: "run_1" });
    assert.equal(job.sessionId, undefined);
  });

  test("carries the hashed trace identity and filterable tags", () => {
    const payload = buildTracePayload({ ...baseMeta, runId: "run_9", role: "boss" });

    assert.equal(payload.id, "run_9");
    assert.equal(payload.name, "run:run_9");
    assert.deepEqual(payload.tags, ["role:boss", "call_kind:llm"]);
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
    assert.deepEqual(end.usageDetails, { input: 10, output: 5, cached: 2, cacheWrite: 0 });
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

describe("buildDispatchRejectionSpanPayload", () => {
  const startedAt = new Date("2026-06-29T00:00:00.000Z");

  const base = {
    runId: "run_1",
    toolName: "sheets.update_values",
    toolCallId: "tc_1",
    outcome: "invalid_input" as const,
    reason: "Invalid input: expected array, received string",
    signature: "sheets.update_values:invalid_input:invalid_type@values",
    userId: "user_1",
    caller: "boss",
    stepId: "dispatch-tools",
    detail: [{ code: "invalid_type", path: ["values"] }],
    input: { values: "[[1]]" },
    startedAt,
  };

  test("omits input and issue detail when capture is off", () => {
    const payload = buildDispatchRejectionSpanPayload(base, false);

    assert.equal(payload.span.name, "tool:sheets.update_values");
    assert.equal(payload.span.input, undefined);
    assert.deepEqual(payload.span.metadata, {
      kind: "tool",
      outcome: "invalid_input",
      rejectionSignature: "sheets.update_values:invalid_input:invalid_type@values",
      toolName: "sheets.update_values",
      candidateToolName: undefined,
      toolCallId: "tc_1",
      caller: "boss",
      userId: "user_1",
      runId: "run_1",
      stepId: "dispatch-tools",
      detail: undefined,
    });
    assert.deepEqual(payload.end, {
      level: "WARNING",
      statusMessage: "sheets.update_values:invalid_input:invalid_type@values",
    });
  });

  test("attaches only caller-supplied safe input, detail, and reason when capture is on", () => {
    const payload = buildDispatchRejectionSpanPayload(
      {
        ...base,
        input: { url: "https://example.com/?token=[REDACTED]" },
      },
      true,
    );

    assert.deepEqual(payload.span.input, { url: "https://example.com/?token=[REDACTED]" });
    assert.deepEqual(payload.span.metadata.detail, [{ code: "invalid_type", path: ["values"] }]);
    assert.deepEqual(payload.end, {
      level: "WARNING",
      statusMessage: "Invalid input: expected array, received string",
    });
  });

  test("normalizes unknown tool observations and keeps only a sanitized candidate hint", () => {
    const payload = buildDispatchRejectionSpanPayload(
      {
        ...base,
        toolName: "<unknown>",
        candidateToolName: "list_events",
        outcome: "unknown_tool",
        reason: "Tool is not declared",
        signature: "<unknown>:unknown_tool",
        input: undefined,
      },
      true,
    );

    assert.equal(payload.span.name, "tool:<unknown>");
    assert.equal(payload.span.metadata.toolName, "<unknown>");
    assert.equal(payload.span.metadata.candidateToolName, "list_events");
    assert.equal(payload.span.input, undefined);
    assert.deepEqual(payload.end, { level: "WARNING", statusMessage: "Tool is not declared" });
  });
});

describe("buildRuntimeSpanPayload / buildRuntimeSpanEndPayload", () => {
  const startedAt = new Date("2026-07-14T00:00:00.000Z");

  const base = {
    runId: "run_9",
    name: "runtime.dispatch.batch",
    startedAt,
    metadata: { stepId: "dispatch-tools", workflow: "__chat-turn__", caller: "boss", callCount: 3 },
  };

  test("stamps the runtime kind + runId on the opening attributes", () => {
    const payload = buildRuntimeSpanPayload(base, false);
    assert.equal(payload.name, "runtime.dispatch.batch");
    assert.equal(payload.startTime, startedAt);
    assert.deepEqual(payload.metadata, {
      kind: "runtime",
      runId: "run_9",
      stepId: "dispatch-tools",
      workflow: "__chat-turn__",
      caller: "boss",
      callCount: 3,
    });
  });

  test("attaches input only when capture is on (privacy gate)", () => {
    const off = buildRuntimeSpanPayload({ ...base, input: { secret: "value" } }, false);
    assert.equal(off.input, undefined);
    const on = buildRuntimeSpanPayload({ ...base, input: { secret: "value" } }, true);
    assert.deepEqual(on.input, { secret: "value" });
  });

  test("end payload defaults to DEFAULT level and folds status into metadata", () => {
    const end = buildRuntimeSpanEndPayload(
      { status: "committed", metadata: { executed: 2 } },
      false,
    );

    assert.equal(end.level, "DEFAULT");
    assert.equal(end.output, undefined);
    assert.deepEqual(end.metadata, { status: "committed", executed: 2 });
  });

  test("end payload honors an explicit ERROR level and gates output", () => {
    const errored = buildRuntimeSpanEndPayload(
      { status: "error", level: "ERROR", output: "boom" },
      false,
    );

    assert.equal(errored.level, "ERROR");
    assert.equal(errored.output, undefined);
    assert.deepEqual(errored.metadata, { status: "error" });

    const captured = buildRuntimeSpanEndPayload(
      { status: "committed", output: { ok: true } },
      true,
    );

    assert.deepEqual(captured.output, { ok: true });
  });
});

// ── v5 emission shape ────────────────────────────────────────────────────────

/** A real `BasicTracerProvider` wired to an in-memory exporter via the SDK's own processor. */
function makeRecordingProvider() {
  const exporter = new InMemorySpanExporter();

  const processor = new LangfuseSpanProcessor({
    exporter,
    publicKey: "pk-test",
    secretKey: "sk-test",
    exportMode: "immediate",
    mediaUploadEnabled: false,
    environment: "test",
  });

  const provider = new BasicTracerProvider({ spanProcessors: [processor] });

  return { exporter, processor, provider };
}

describe("v5 emission shape (in-memory exporter)", () => {
  let exporter!: InMemorySpanExporter;
  let processor!: LangfuseSpanProcessor;
  let restoreRuntime: (() => void) | undefined;

  before(() => {
    const recording = makeRecordingProvider();

    exporter = recording.exporter;
    processor = recording.processor;
    restoreRuntime = _setLangfuseRuntimeForTests(recording.provider);
  });

  after(() => {
    restoreRuntime?.();
  });

  beforeEach(() => {
    exporter.reset();
  });

  async function emittedSpans(): Promise<ReadableSpan[]> {
    await processor.forceFlush();

    return exporter.getFinishedSpans();
  }

  test("a run generation joins the hashed trace and carries the trace attributes", async () => {
    const meta: MeteredMeta = {
      ...baseMeta,
      role: "boss",
      runId: "run_verify",
      sessionId: "thread_1",
      userId: "user_1",
      name: "agent:chat",
    };

    const closer = startLangfuseSpan({ meta, startedAt: new Date() });

    closer.success({
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
      costUsd: 0.01,
      responseMeta: { finishReason: "stop" },
    });

    const gen = (await emittedSpans()).find((s) => s.name === "agent:chat");

    assert.ok(gen, "generation span exported");
    assert.equal(gen.spanContext().traceId, langfuseTraceId("run_verify"));
    assert.equal(gen.attributes[A.OBSERVATION_TYPE], "generation");
    assert.equal(gen.attributes[A.OBSERVATION_MODEL], "claude-sonnet-4-6");
    assert.equal(gen.attributes[A.TRACE_NAME], "run:run_verify");
    assert.equal(gen.attributes[A.TRACE_USER_ID], "user_1");
    assert.equal(gen.attributes[A.TRACE_SESSION_ID], "thread_1");
    assert.deepEqual(gen.attributes[A.TRACE_TAGS], ["role:boss", "call_kind:llm"]);
    assert.equal(gen.attributes[A.ENVIRONMENT], "test");
    assert.equal(gen.attributes[`${A.OBSERVATION_METADATA}.role`], "boss");
    assert.deepEqual(JSON.parse(String(gen.attributes[A.OBSERVATION_USAGE_DETAILS])), {
      input: 10,
      output: 5,
      cached: 2,
      cacheWrite: 0,
    });
    assert.deepEqual(JSON.parse(String(gen.attributes[A.OBSERVATION_COST_DETAILS])), {
      total: 0.01,
    });
  });

  test("a tool span exports under the run trace with structural metadata", async () => {
    const closer = startToolSpan({
      runId: "run_tools",
      toolName: "sheets.update_values",
      toolCallId: "tc_1",
      userId: "user_1",
      caller: "boss",
      startedAt: new Date(),
    });

    closer.success({ ok: true }, { truncated: true });

    const span = (await emittedSpans()).find((s) => s.name === "tool:sheets.update_values");

    assert.ok(span, "tool span exported");
    assert.equal(span.spanContext().traceId, langfuseTraceId("run_tools"));
    assert.equal(span.attributes[A.OBSERVATION_TYPE], "span");
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.kind`], "tool");
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.toolCallId`], "tc_1");
    // Merge semantics: update() keeps the open-time metadata and adds the end one.
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.truncated`], "true");
    // I/O capture is off by default, so neither payload is exported.
    assert.equal(span.attributes[A.OBSERVATION_INPUT], undefined);
    assert.equal(span.attributes[A.OBSERVATION_OUTPUT], undefined);
  });

  test("a dispatch rejection exports a WARNING span keyed by its signature", async () => {
    recordDispatchRejection({
      runId: "run_reject",
      toolName: "<unknown>",
      candidateToolName: "list_events",
      toolCallId: "tc_2",
      outcome: "unknown_tool",
      reason: "Tool is not declared",
      signature: "<unknown>:unknown_tool",
      startedAt: new Date(),
    });

    const span = (await emittedSpans()).find((s) => s.name === "tool:<unknown>");

    assert.ok(span, "rejection span exported");
    assert.equal(span.attributes[A.OBSERVATION_TYPE], "span");
    assert.equal(span.attributes[A.OBSERVATION_LEVEL], "WARNING");
    assert.equal(span.attributes[A.OBSERVATION_STATUS_MESSAGE], "<unknown>:unknown_tool");
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.outcome`], "unknown_tool");
    assert.equal(
      span.attributes[`${A.OBSERVATION_METADATA}.rejectionSignature`],
      "<unknown>:unknown_tool",
    );
  });

  test("a runtime span exports its name, kind, and terminal status", async () => {
    startRuntimeSpan({
      runId: "run_runtime",
      name: "runtime.dispatch.batch",
      startedAt: new Date(),
      metadata: { stepId: "dispatch-tools", callCount: 3 },
    }).end({ status: "committed", metadata: { executed: 2 } });

    const span = (await emittedSpans()).find((s) => s.name === "runtime.dispatch.batch");

    assert.ok(span, "runtime span exported");
    assert.equal(span.attributes[A.OBSERVATION_TYPE], "span");
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.kind`], "runtime");
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.status`], "committed");
    assert.equal(span.attributes[`${A.OBSERVATION_METADATA}.executed`], "2");
  });

  test("does not write trace attributes onto a non-Langfuse active span", () => {
    // Stand in for Sentry's process-global provider: a recording provider whose
    // span is active while a Langfuse generation is emitted.
    const globalExporter = new InMemorySpanExporter();

    const globalProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(globalExporter)],
    });

    otelTrace.setGlobalTracerProvider(globalProvider);

    const globalSpan = globalProvider.getTracer("sentry").startSpan("sentry.http.request");

    try {
      otelContext.with(otelTrace.setSpan(otelContext.active(), globalSpan), () => {
        const closer = startLangfuseSpan({
          meta: {
            ...baseMeta,
            runId: "run_leak",
            sessionId: "thread_leak",
            userId: "user_leak",
            role: "boss",
            name: "agent:leak",
          },
          startedAt: new Date(),
        });

        closer.success({ costUsd: 0.001 });
      });
    } finally {
      globalSpan.end();
    }

    const global = globalExporter.getFinishedSpans()[0];

    assert.ok(global, "global span exported");
    assert.equal(global.attributes[A.TRACE_USER_ID], undefined);
    assert.equal(global.attributes[A.TRACE_SESSION_ID], undefined);
    assert.equal(global.attributes[A.TRACE_NAME], undefined);
    assert.equal(global.attributes[A.TRACE_TAGS], undefined);
    assert.equal(global.attributes[A.ENVIRONMENT], undefined);
  });
});

import { serverEnv } from "@alfred/env/server";
import { randomUUID } from "node:crypto";
import { Langfuse } from "langfuse";
import type { CallUsage, MeteredMeta } from "./types";
import { toMessage } from "@alfred/contracts";

/**
 * Lazy-init Langfuse client. We construct it once per process when the
 * keys are present; missing keys mean the rest of `metered()` becomes a
 * no-op for tracing — the `api_call_log` row still lands.
 *
 * Per ADR-0023 (and confirmed in m6): tracing wires alongside metering,
 * keys gate emission. When the keys are absent (local dev without LF
 * setup, CI), this module reports a `noop` instance so call sites stay
 * branch-free.
 */
let _client: Langfuse | "noop" | undefined;

function getClient(): Langfuse | null {
  if (_client === "noop") return null;
  if (_client) return _client;
  const env = serverEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    _client = "noop";
    return null;
  }
  _client = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST,
    // Stamp every trace with the deploy environment (#226) so local and prod
    // traces never blur once both report. `NODE_ENV` is already one of
    // development|production|test — all valid Langfuse environment slugs
    // (lowercase, no leading "langfuse"), so it maps straight through.
    environment: env.NODE_ENV,
  });
  return _client;
}

export interface LangfuseSpanInput {
  meta: MeteredMeta;
  startedAt: Date;
}

/**
 * Open a Langfuse generation span. Use `runId` as the trace id so all
 * calls inside one agent run group into a single tree (boss + sub-agents
 * inherited from m13 will hang off the same trace via parent links).
 *
 * Returns a closer with two outcomes — `success(usage, costUsd, output)`
 * or `error(message)`. Both are best-effort: any throw inside the
 * Langfuse SDK is swallowed so tracing failures never break the call.
 */
export interface LangfuseSpanCloser {
  success(args: {
    usage?: CallUsage;
    costUsd: number;
    /** Full completion — only attached to the span when I/O capture is on. */
    output?: unknown;
    /** Small response metadata (finish_reason, tool-call count) — always attached. */
    responseMeta?: Record<string, unknown>;
    /**
     * Model the request actually resolved to (#216). When a `withFallback`
     * cascade switches providers mid-call, `metered()` reconciles the served
     * id and passes it here so the generation's `model` reflects what ran —
     * not the nominal id the span opened with. Defaults to the requested id
     * when undefined or unchanged.
     */
    servedModel?: string;
  }): void;
  error(message: string): void;
}

/**
 * Whether to attach full prompt/completion text to spans. Gated by
 * `LANGFUSE_CAPTURE_IO` (#215) so the default stays I/O-free and prompt
 * content (potential PII) never leaves the box unless explicitly enabled
 * on a self-hosted instance.
 */
function shouldCaptureIo(): boolean {
  return serverEnv().LANGFUSE_CAPTURE_IO === true;
}

export function startLangfuseSpan(input: LangfuseSpanInput): LangfuseSpanCloser {
  const client = getClient();
  if (!client) {
    return {
      success() {
        /* no-op when keys missing */
      },
      error() {
        /* no-op */
      },
    };
  }

  const { meta, startedAt } = input;
  // Prefer runId so calls inside one run group; fall back to idempotency
  // key (stable across retries) and finally a UUID. Date.now() would
  // collide for concurrent calls in the same ms and merge unrelated traces.
  const traceId = meta.runId ?? `adhoc:${meta.idempotencyKey ?? randomUUID()}`;
  // The trace names the whole run; the generation below names the call. A run
  // mixes models and roles (boss + sub-agents + compactor), so naming the trace
  // after any single call's `provider/model` would churn — every call upserts
  // the trace, and the last writer would win. `run:<id>` is stable by
  // construction. Ad-hoc traces hold exactly one generation (unique traceId per
  // call), so there's no churn and the descriptive name is more useful there.
  const traceName = meta.runId
    ? `run:${meta.runId}`
    : (meta.name ?? `${meta.provider}/${meta.model}`);
  // generation() in Langfuse v3 returns an object with .end()/.update().
  // We catch construction errors so a misconfigured SDK can't crash the
  // call site.
  const captureIo = shouldCaptureIo();
  // Ad-hoc traces hold exactly one generation (unique traceId per call), so the
  // trace root is the call — mirror the generation I/O up to it (#226) so the
  // Traces view stops showing the "didn't receive input/output" banner. Run
  // traces hold many generations; mirroring any single call's I/O to the root
  // would misrepresent the run, so we leave the root I/O off there.
  const isAdhocTrace = !meta.runId;
  let generation: ReturnType<Langfuse["generation"]> | null = null;
  try {
    // Upsert the parent trace first. `generation()` with a custom traceId
    // does NOT create the trace — Langfuse Cloud no longer auto-promotes
    // orphan observations, so without this the Traces view is empty and
    // runId grouping never materializes. Idempotent on `id`: every call in
    // one run collapses into a single trace tree. Only run-stable fields go
    // here; per-call identity (model) lives on the generation, so the repeated
    // upserts don't rewrite the trace with the last call's values. Tags are
    // unioned by Langfuse across upserts, so a multi-role run accumulates every
    // surface tag rather than the last writer winning.
    client.trace({
      id: traceId,
      name: traceName,
      userId: meta.userId,
      // Group a multi-turn conversation (each turn its own run/trace) under one
      // Sessions-view entry. Chat passes `threadId`; everything else falls back
      // to the run id so a run's traces still group sensibly (#226).
      sessionId: meta.sessionId ?? meta.runId,
      // Promote role/kind to filterable trace tags (#226) — they otherwise only
      // live in generation metadata, which the Traces filter can't slice by.
      tags: traceTags(meta),
      input: captureIo && isAdhocTrace ? meta.input : undefined,
    });
    generation = client.generation({
      traceId,
      name: meta.name ?? `${meta.provider}/${meta.model}`,
      model: meta.model,
      modelParameters: stripParams(meta.requestMeta),
      startTime: startedAt,
      input: captureIo ? meta.input : undefined,
      metadata: {
        kind: meta.kind,
        role: meta.role,
        userId: meta.userId,
        runId: meta.runId,
        stepId: meta.stepId,
        attempt: meta.attempt,
        idempotencyKey: meta.idempotencyKey,
      },
    });
  } catch (err) {
    console.warn("[langfuse] span start failed:", toMessage(err));
  }

  return {
    success({ usage, costUsd, output, responseMeta, servedModel }) {
      try {
        // The span opened with the requested model; if the call actually
        // resolved to a different (registry-known) model via fallback, restamp
        // the generation so per-model cost/latency attributes correctly, and
        // keep the requested id in metadata for fallback debugging (#216).
        const servedDiverged = servedModel != null && servedModel !== meta.model;
        generation?.end({
          model: servedDiverged ? servedModel : undefined,
          usage: usage
            ? {
                input: usage.inputTokens,
                output: usage.outputTokens,
                total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                unit: "TOKENS",
              }
            : undefined,
          usageDetails: usage
            ? {
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
                cached: usage.cachedInputTokens ?? 0,
              }
            : undefined,
          // Cost in USD; Langfuse's `costDetails` accepts arbitrary keys.
          costDetails: { total: costUsd },
          // Full completion only when capture is on; the small response
          // metadata (finish_reason, tool-call count) is always useful.
          output: captureIo ? output : undefined,
          metadata: servedDiverged ? { ...responseMeta, requestedModel: meta.model } : responseMeta,
        });
        // Mirror the completion up to an ad-hoc trace's root (#226) so the
        // Traces view shows the call's I/O instead of the empty-root banner.
        if (captureIo && isAdhocTrace) {
          client.trace({ id: traceId, output });
        }
      } catch (err) {
        console.warn("[langfuse] span end failed:", toMessage(err));
      }
    },
    error(message) {
      try {
        generation?.end({ level: "ERROR", statusMessage: message });
      } catch (err) {
        console.warn("[langfuse] span error end failed:", toMessage(err));
      }
    },
  };
}

/**
 * Best-effort flush so a CLI script (smoke tests, sync-prices) doesn't
 * exit before in-flight Langfuse events are sent. Server processes
 * call this on graceful shutdown.
 */
export async function flushLangfuse(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.flushAsync();
  } catch (err) {
    console.warn("[langfuse] flush failed:", toMessage(err));
  }
}

export async function shutdownLangfuse(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.shutdownAsync();
  } catch {
    /* swallow */
  }
}

/**
 * Build the filterable trace tags from a call's attribution (#226). `role`
 * names the surface (chat/triage/briefing/cold_start/…) and `kind` the call
 * shape (llm/embedding/web_search); both are namespaced so the Traces filter
 * reads cleanly (`role:triage`, `kind:embedding`). Returns undefined when
 * neither is present so we don't stamp an empty array.
 */
function traceTags(meta: MeteredMeta): string[] | undefined {
  const tags: string[] = [];
  if (meta.role) tags.push(`role:${meta.role}`);
  if (meta.kind) tags.push(`kind:${meta.kind}`);
  return tags.length > 0 ? tags : undefined;
}

type LangfuseModelParam = string | number | boolean | string[] | null;

function stripParams(
  meta: Record<string, unknown> | undefined,
): { [key: string]: LangfuseModelParam } | undefined {
  if (!meta) return undefined;
  // Drop fields that are too large or not relevant to the trace, and coerce
  // remaining values to the primitive shapes Langfuse accepts.
  const skip = new Set(["prompt", "messages", "system"]);
  const out: { [key: string]: LangfuseModelParam } = {};
  for (const [k, v] of Object.entries(meta)) {
    if (skip.has(k)) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v as string[];
    }
    // Anything else (objects, mixed arrays) is silently dropped — Langfuse
    // can't render them and including them broke the type contract.
  }
  return out;
}

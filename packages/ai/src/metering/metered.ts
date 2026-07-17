import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { findModelProvider } from "../models";
import { startLangfuseSpan } from "./langfuse";
import { computeCost, getPrice } from "./prices";
import type { MeteredMeta, MeteredResult, ResultExtractor } from "./types";
import { toMessage } from "@alfred/contracts";

const pendingMeteringWrites = new Set<Promise<void>>();

function enqueueMeteringWrite(write: Promise<void>): void {
  const tracked = write
    .catch((err) => console.warn("[metered] background settlement failed:", toMessage(err)))
    .finally(() => pendingMeteringWrites.delete(tracked));
  pendingMeteringWrites.add(tracked);
}

/** Wait for metering work already accepted by this process; used by scripts and shutdown. */
export async function flushMeteringWrites(): Promise<void> {
  while (pendingMeteringWrites.size > 0) {
    await Promise.all(pendingMeteringWrites);
  }
}

/**
 * Reconcile the pre-call attribution (`meta.provider`/`meta.model`, resolved
 * from the model object before dispatch) with the model the provider reports
 * actually serving (`extracted.served`, from `response.modelId`). The two
 * diverge when a `withFallback` cascade switches providers mid-call.
 *
 * Registry-gated: only a served id that maps to a known `MODEL_REGISTRY`
 * entry overrides the meta — providers echo dated aliases of the requested
 * model (e.g. a dated Gemini alias) and those must not knock attribution to
 * `unknown`. A divergent-but-unrecognized id is still surfaced on
 * `response_meta.servedModelId` so the row is auditable.
 */
function reconcileServed(
  meta: MeteredMeta,
  extracted: MeteredResult,
): { provider: string; model: string; responseMeta: MeteredResult["responseMeta"] } {
  const served = extracted.served?.model;
  if (!served || served === meta.model) {
    return { provider: meta.provider, model: meta.model, responseMeta: extracted.responseMeta };
  }
  const responseMeta = { ...extracted.responseMeta, servedModelId: served };
  const provider = findModelProvider(served);
  if (!provider) {
    return { provider: meta.provider, model: meta.model, responseMeta };
  }
  return { provider, model: served, responseMeta };
}

/**
 * The single chokepoint for every billable external call. Per ADR-0015:
 * grep the codebase for `metered(` to enumerate them.
 *
 * Behaviour:
 *  - Records latency from before-call to after-resolve.
 *  - Calls `extract` on success to pull usage out of the SDK's typed
 *    return value; the caller is the one place that knows the result
 *    shape, so the helper stays generic.
 *  - On failure: writes an error row with `cost_usd=0`, then rethrows so
 *    callers see the original error (same stack, same type).
 *  - DB write fires-and-forgets — we never let logging block the user-
 *    visible call path. Errors during the write are logged and dropped.
 *  - Langfuse span is opened in parallel and ended in the same close
 *    branch.
 */
export async function metered<T>(
  meta: MeteredMeta,
  fn: () => Promise<T>,
  extract?: ResultExtractor<T>,
): Promise<T> {
  const startedAt = new Date();
  const span = startLangfuseSpan({ meta, startedAt });
  try {
    const result = await fn();
    const extracted: MeteredResult = extract ? extract(result) : {};
    const latencyMs = Date.now() - startedAt.getTime();
    const served = reconcileServed(meta, extracted);
    const price = await getPrice(served.provider, served.model);
    const costUsd = computeCost(price, extracted.usage);
    enqueueMeteringWrite(
      writeLogRow({
        meta: { ...meta, provider: served.provider, model: served.model },
        latencyMs,
        usage: extracted.usage,
        costUsd,
        responseMeta: served.responseMeta,
        error: null,
      }),
    );
    span.success({
      usage: extracted.usage,
      costUsd,
      output: extracted.output,
      responseMeta: served.responseMeta,
      servedModel: served.model,
    });
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt.getTime();
    const message = toMessage(err);
    enqueueMeteringWrite(
      writeLogRow({
        meta,
        latencyMs,
        usage: undefined,
        costUsd: 0,
        responseMeta: undefined,
        error: { message },
      }),
    );
    span.error(message);
    throw err;
  }
}

/**
 * Streaming sibling of `metered()`. A streamed call can't be metered with a
 * single await — `streamText` returns immediately and usage is only known
 * once the stream finishes. So instead of wrapping a thunk, this hands the
 * caller two callbacks to wire into the SDK's `onEnd` / `onError` hooks:
 *
 *   - `finish(result)` — call once when the stream completes, with the same
 *     `MeteredResult` shape `metered()`'s extractor returns. Computes cost,
 *     writes the `api_call_log` row, closes the Langfuse span.
 *   - `fail(message)` — call on stream error. Writes an error row, ends the
 *     span. The caller still rethrows/propagates as it sees fit.
 *
 * Both are idempotent — only the first call lands — so wiring them into both
 * `onEnd` and a `try/catch` is safe. The span opens synchronously here so
 * latency is measured from before the model call, matching `metered()`.
 */
export function meteredStream<T>(
  meta: MeteredMeta,
  start: (hooks: {
    finish: (result: MeteredResult) => void;
    fail: (message: string) => void;
    abort: (result: MeteredResult) => void;
  }) => T,
): T {
  const startedAt = new Date();
  const span = startLangfuseSpan({ meta, startedAt });
  let settled = false;
  const settleWithUsage = (extracted: MeteredResult, aborted: boolean): void => {
    if (settled) return;
    settled = true;
    const latencyMs = Date.now() - startedAt.getTime();
    const served = reconcileServed(meta, extracted);
    const responseMeta = aborted ? { ...served.responseMeta, aborted: true } : served.responseMeta;
    enqueueMeteringWrite(
      (async () => {
        const price = await getPrice(served.provider, served.model);
        const costUsd = computeCost(price, extracted.usage);
        await writeLogRow({
          meta: { ...meta, provider: served.provider, model: served.model },
          latencyMs,
          usage: extracted.usage,
          costUsd,
          responseMeta,
          error: null,
        });
        span.success({
          usage: extracted.usage,
          costUsd,
          output: extracted.output,
          responseMeta,
          servedModel: served.model,
        });
      })(),
    );
  };
  const finish = (extracted: MeteredResult): void => {
    settleWithUsage(extracted, false);
  };
  const abort = (extracted: MeteredResult): void => {
    settleWithUsage(extracted, true);
  };
  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    const latencyMs = Date.now() - startedAt.getTime();
    enqueueMeteringWrite(
      writeLogRow({
        meta,
        latencyMs,
        usage: undefined,
        costUsd: 0,
        responseMeta: undefined,
        error: { message },
      }),
    );
    span.error(message);
  };
  return start({ finish, fail, abort });
}

interface WriteArgs {
  meta: MeteredMeta;
  latencyMs: number;
  usage: MeteredResult["usage"];
  costUsd: number;
  responseMeta: MeteredResult["responseMeta"];
  error: { message: string } | null;
}

async function writeLogRow(args: WriteArgs): Promise<void> {
  const { meta, latencyMs, usage, costUsd, responseMeta, error } = args;
  try {
    await db()
      .insert(apiCallLog)
      .values({
        kind: meta.kind,
        provider: meta.provider,
        model: meta.model,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedInputTokens: usage?.cachedInputTokens,
        cacheWriteInputTokens: usage?.cacheWriteInputTokens,
        costUsd: costUsd.toFixed(8),
        latencyMs,
        userId: meta.userId,
        runId: meta.runId,
        stepId: meta.stepId,
        attempt: meta.attempt,
        messageId: meta.messageId,
        requestMeta: {
          ...meta.requestMeta,
          idempotencyKey: meta.idempotencyKey,
          ...(meta.role ? { role: meta.role } : {}),
        },
        responseMeta: responseMeta ?? null,
        error,
      });
  } catch (err) {
    console.warn("[metered] failed to write api_call_log row:", toMessage(err));
  }
}

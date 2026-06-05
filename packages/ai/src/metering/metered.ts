import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { startLangfuseSpan } from "./langfuse";
import { computeCost, getPrice } from "./prices";
import type { MeteredMeta, MeteredResult, ResultExtractor } from "./types";

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
    const price = await getPrice(meta.provider, meta.model);
    const costUsd = computeCost(price, extracted.usage);
    void writeLogRow({
      meta,
      latencyMs,
      usage: extracted.usage,
      costUsd,
      responseMeta: extracted.responseMeta,
      error: null,
    });
    span.success({ usage: extracted.usage, costUsd, output: extracted.responseMeta });
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt.getTime();
    const message = err instanceof Error ? err.message : String(err);
    void writeLogRow({
      meta,
      latencyMs,
      usage: undefined,
      costUsd: 0,
      responseMeta: undefined,
      error: { message },
    });
    span.error(message);
    throw err;
  }
}

/**
 * Streaming sibling of `metered()`. A streamed call can't be metered with a
 * single await — `streamText` returns immediately and usage is only known
 * once the stream finishes. So instead of wrapping a thunk, this hands the
 * caller two callbacks to wire into the SDK's `onFinish` / `onError` hooks:
 *
 *   - `finish(result)` — call once when the stream completes, with the same
 *     `MeteredResult` shape `metered()`'s extractor returns. Computes cost,
 *     writes the `api_call_log` row, closes the Langfuse span.
 *   - `fail(message)` — call on stream error. Writes an error row, ends the
 *     span. The caller still rethrows/propagates as it sees fit.
 *
 * Both are idempotent — only the first call lands — so wiring them into both
 * `onFinish` and a `try/catch` is safe. The span opens synchronously here so
 * latency is measured from before the model call, matching `metered()`.
 */
export function meteredStream<T>(
  meta: MeteredMeta,
  start: (hooks: {
    finish: (result: MeteredResult) => void;
    fail: (message: string) => void;
  }) => T,
): T {
  const startedAt = new Date();
  const span = startLangfuseSpan({ meta, startedAt });
  let settled = false;
  const finish = (extracted: MeteredResult): void => {
    if (settled) return;
    settled = true;
    const latencyMs = Date.now() - startedAt.getTime();
    void (async () => {
      const price = await getPrice(meta.provider, meta.model);
      const costUsd = computeCost(price, extracted.usage);
      void writeLogRow({
        meta,
        latencyMs,
        usage: extracted.usage,
        costUsd,
        responseMeta: extracted.responseMeta,
        error: null,
      });
      span.success({ usage: extracted.usage, costUsd, output: extracted.responseMeta });
    })();
  };
  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    const latencyMs = Date.now() - startedAt.getTime();
    void writeLogRow({
      meta,
      latencyMs,
      usage: undefined,
      costUsd: 0,
      responseMeta: undefined,
      error: { message },
    });
    span.error(message);
  };
  return start({ finish, fail });
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
    console.warn(
      "[metered] failed to write api_call_log row:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

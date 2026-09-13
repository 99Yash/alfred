import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { isCallerAbort } from "../abort";
import { startLangfuseSpan } from "./langfuse";
import { computeCost, getPrice } from "./prices";
import type { MeteredMeta, MeteredResult, ResultExtractor } from "./types";
import { redactSecrets, toMessage } from "@alfred/contracts";
import { APICallError } from "@ai-sdk/provider";

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
 * from the model object before dispatch) with the model the provider object
 * reports actually serving. The two diverge when a `withFallback` cascade
 * switches providers mid-call: the composed model proxies `provider`/`modelId`
 * to whichever leg currently serves, and the extractor reads it after the call.
 *
 * Identity comes off the model object, so a provider's dated alias echo never
 * knocks attribution to `unknown`. A divergence is surfaced on
 * `response_meta.servedModelId` so the row is auditable.
 */
function reconcileServed(meta: MeteredMeta, extracted: MeteredResult) {
  const served = extracted.served;

  if (!served || (served.provider === meta.provider && served.model === meta.model)) {
    return { provider: meta.provider, model: meta.model, responseMeta: extracted.responseMeta };
  }

  // `requestedModelId` is the pre-call attribution — the route's primary when a
  // `withFallback` cascade fired — so a usage rollup can name the model that
  // errored beside the one that answered. Only written on divergence, like
  // `servedModelId`, so the common same-model row stays untouched.
  const responseMeta = {
    ...extracted.responseMeta,
    servedModelId: served.model,
    requestedModelId: meta.model,
  };

  return { provider: served.provider, model: served.model, responseMeta };
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
 *  - On a caller-initiated **abort**: writes a row marked
 *    `response_meta.aborted` with `error = null`, then rethrows. A cancel is
 *    not a fault — the triage hedge (#436) cancels one of two live draws on
 *    purpose — and logging it as an error would put a deliberate abort per
 *    hedge event into the `role=triage` error rows and Langfuse's error count,
 *    distinguishable only by string-matching the message.
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

    if (isCallerAbort(err)) {
      // A cancelled generate carries no usage — the SDK throws instead of
      // returning a result, and the provider reports nothing for a request we
      // hung up on. So the row is honest about *what happened* (aborted, not
      // failed) while being unable to be honest about tokens: the provider
      // still bills partial work, and `cost_usd` stays 0.
      //
      // Consequence worth knowing before reading a cost dashboard: summing
      // `cost_usd` under-reports a hedged call site by roughly its loser's
      // share. Count the duplicates via `request_meta.hedge` (marked on both
      // draws) and `response_meta.aborted` rather than trusting the sum.
      enqueueMeteringWrite(
        writeLogRow({
          meta,
          latencyMs,
          usage: undefined,
          costUsd: 0,
          responseMeta: { aborted: true },
          error: null,
        }),
      );
      span.success({ costUsd: 0, responseMeta: { aborted: true }, servedModel: meta.model });
      throw err;
    }

    const message = toMessage(err);
    enqueueMeteringWrite(
      writeLogRow({
        meta,
        latencyMs,
        usage: undefined,
        costUsd: 0,
        responseMeta: undefined,
        error: { message },
        transport: transportFacts(err),
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
 *   - `fail(cause)` — call on stream error with the RAW error, not a message.
 *     Writes an error row, ends the span. The caller still rethrows/propagates
 *     as it sees fit. The raw value is needed because `status_code` and
 *     `response_body` only exist on an `APICallError`, and a message string has
 *     already thrown both away.
 *
 * Both are idempotent — only the first call lands — so wiring them into both
 * `onEnd` and a `try/catch` is safe. The span opens synchronously here so
 * latency is measured from before the model call, matching `metered()`.
 */
export function meteredStream<T>(
  meta: MeteredMeta,
  start: (hooks: {
    finish: (result: MeteredResult) => void;
    fail: (cause: unknown) => void;
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

  const fail = (cause: unknown): void => {
    if (settled) return;
    settled = true;
    const message = toMessage(cause);
    const latencyMs = Date.now() - startedAt.getTime();
    enqueueMeteringWrite(
      writeLogRow({
        meta,
        latencyMs,
        usage: undefined,
        costUsd: 0,
        responseMeta: undefined,
        error: { message },
        transport: transportFacts(cause),
      }),
    );
    span.error(message);
  };

  return start({ finish, fail, abort });
}

/**
 * Longest error body kept on a row. A provider error body is a few hundred
 * bytes; the cap only bounds a provider that answers a failure with a page.
 */
const MAX_RESPONSE_BODY_CHARS = 2_000;

/** The two transport columns a failed `api_call_log` row can carry. */
interface TransportFacts {
  readonly statusCode?: number;
  readonly responseBody?: string;
}

/**
 * The transport facts a failed call carries beyond its message, for the two
 * columns that exist so a 429 can be diagnosed without the provider dashboard.
 *
 * Only an `APICallError` has them. Everything else — an abort, a socket fault,
 * a schema parse failure — leaves both NULL, which is the honest answer rather
 * than a zero.
 */
function transportFacts(err: unknown): TransportFacts {
  if (!APICallError.isInstance(err)) return {};
  const body = err.responseBody;

  return {
    ...(err.statusCode === undefined ? {} : { statusCode: err.statusCode }),
    ...(body === undefined
      ? {}
      : { responseBody: redactSecrets(body).slice(0, MAX_RESPONSE_BODY_CHARS) }),
  };
}

interface WriteArgs {
  meta: MeteredMeta;
  latencyMs: number;
  usage: MeteredResult["usage"];
  costUsd: number;
  responseMeta: MeteredResult["responseMeta"];
  error: { message: string } | null;
  transport?: TransportFacts;
}

async function writeLogRow(args: WriteArgs): Promise<void> {
  const { meta, latencyMs, usage, costUsd, responseMeta, error, transport } = args;

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
        statusCode: transport?.statusCode ?? null,
        responseBody: transport?.responseBody ?? null,
      });
  } catch (err) {
    console.warn("[metered] failed to write api_call_log row:", toMessage(err));
  }
}

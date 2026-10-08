import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { findApiCallError, isCallerAbort } from "../abort";
import { startLangfuseSpan } from "./langfuse";
import { computeCost, getPrice, type PriceLookup } from "./prices";
import { summarizeBody, toMessage, type AttributionKind, type JsonObject } from "@alfred/contracts";

// Hand-written on purpose: these are the API of `metered()`, not a table row or a zod schema.

/** Token usage, read from the SDK result after the call. */
export interface CallUsage {
  inputTokens?: number | undefined;
  /** Canonical non-cached prompt tokens reported by AI SDK 7. */
  noCacheInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
  /** Cache write retention, when the provider prices it differently. */
  cacheWriteTtl?: "5m" | "1h" | undefined;
}

/** `api_call_log.kind`. Defined in `@alfred/contracts` so the web can read it. */
export type CallKind = AttributionKind;

/** The caller of an LLM call, stored in `request_meta.role` so cost rollups can split a run by role. */
export type CallRole =
  | "compactor"
  | "boss"
  | "sub_agent"
  | "triage"
  | "briefing"
  | "cold_start"
  | "memory_extraction";

/** Attribution for the call row. All optional, because calls outside an agent are metered too. */
export interface CallAttribution {
  userId?: string | undefined;
  runId?: string | undefined;
  stepId?: string | undefined;
  attempt?: number | undefined;
  messageId?: string | undefined;
  /** Overrides the wrapper default `'llm'`, for example `'web_search'` (ADR-0015). */
  kind?: CallKind | undefined;
  role?: CallRole | undefined;
  /** Langfuse only. Chat passes `threadId`; background runs omit it. */
  sessionId?: string | undefined;
}

export interface MeteredMeta extends CallAttribution {
  kind: CallKind;
  provider: string;
  model: string;
  /** Stored in `request_meta` and tags the trace. Agent steps pass `${runId}:${stepId}:${attempt}`. */
  idempotencyKey?: string | undefined;
  /** Model params for `request_meta`. No full prompts. */
  requestMeta?: JsonObject | undefined;
  /** Langfuse name. Defaults to `${provider}/${model}`. */
  name?: string | undefined;
  /** Langfuse only, and only with `LANGFUSE_CAPTURE_IO=true`. Never written to `api_call_log`. */
  input?: unknown;
}

/** One step of a multi-step turn. */
export interface MeteredStep {
  provider: string;
  model: string;
  usage: CallUsage | undefined;
}

/** What `metered()` reads from a successful SDK result. */
export interface MeteredResult {
  /** The turn total. */
  usage?: CallUsage | undefined;
  responseMeta?: JsonObject | undefined;
  /** With more than one step, each step is priced on its own leg. */
  steps?: readonly MeteredStep[] | undefined;
  /** Langfuse only, and only with `LANGFUSE_CAPTURE_IO=true`. */
  output?: unknown;
  /**
   * The leg that actually served the call. A fallback can switch legs after `meta` was
   * resolved, so this wins when it differs. Set by `servedFromModel` in `./wrappers`.
   */
  served?: { provider: string; model: string } | undefined;
  /**
   * The response model id when it names no leg of the route, so the miss stays visible.
   * Anthropic dated snapshot ids miss often.
   */
  servedUnresolved?: string | undefined;
}

export type ResultExtractor<T> = (value: T) => MeteredResult;

const pendingMeteringWrites = new Set<Promise<void>>();

function enqueueMeteringWrite(write: Promise<void>): void {
  const tracked = write
    .catch((err) => console.warn("[metered] background settlement failed:", toMessage(err)))
    .finally(() => pendingMeteringWrites.delete(tracked));

  pendingMeteringWrites.add(tracked);
}

/** Wait for pending metering writes. Call it before a script exits. */
export async function flushMeteringWrites(): Promise<void> {
  while (pendingMeteringWrites.size > 0) {
    await Promise.all(pendingMeteringWrites);
  }
}

/** Attribute the row to the leg that served, and record any divergence in `response_meta`. */
function reconcileServed(meta: MeteredMeta, extracted: MeteredResult) {
  const served = extracted.served;
  const unresolved = extracted.servedUnresolved;

  if (!served || (served.provider === meta.provider && served.model === meta.model)) {
    if (unresolved === undefined) {
      return { provider: meta.provider, model: meta.model, responseMeta: extracted.responseMeta };
    }

    return {
      provider: meta.provider,
      model: meta.model,
      responseMeta: { ...extracted.responseMeta, servedModelIdUnresolved: unresolved },
    };
  }

  // Written only on divergence, so a rollup can name the model that failed.
  const responseMeta = {
    ...extracted.responseMeta,
    servedModelId: served.model,
    requestedModelId: meta.model,
  };

  return { provider: served.provider, model: served.model, responseMeta };
}

/**
 * Cost of one turn. A multi-step turn prices each step on its own leg.
 * The row still names one leg while `cost_usd` sums all of them; `response_meta.stepModels`
 * lists the mix. One row per turn (ADR-0015).
 */
async function costForExtracted(
  extracted: MeteredResult,
  served: { provider: string; model: string },
): Promise<number> {
  const steps = extracted.steps;

  if (!steps || steps.length <= 1) {
    const price = await getPrice(served.provider, served.model);

    if (!price && extracted.usage) {
      warnOnMissingPrice(served.provider, served.model);
    }

    return computeCost(price, extracted.usage);
  }

  const prices = new Map<string, PriceLookup | null>();

  for (const step of steps) {
    const key = `${step.provider}:${step.model}`;

    if (!prices.has(key)) {
      prices.set(key, await getPrice(step.provider, step.model));
    }
  }

  let total = 0;

  for (const step of steps) {
    const price = prices.get(`${step.provider}:${step.model}`) ?? null;

    if (!price && step.usage) {
      warnOnMissingPrice(step.provider, step.model);
    }

    total += computeCost(price, step.usage);
  }

  return total;
}

/** A missing price logs cost 0. Warn, or a dropped price sync looks like free traffic. */
function warnOnMissingPrice(provider: string, model: string): void {
  console.warn(
    `[metered] no model_prices row for ${provider}/${model} — logging cost 0; run \`pnpm --filter @alfred/db db:sync-prices\``,
  );
}

/**
 * Every billable external call goes through here (ADR-0015). Writes one `api_call_log` row
 * and one Langfuse span, without blocking the call, and rethrows the original error.
 * A caller abort is logged as `aborted`, not as an error: the triage hedge cancels on purpose.
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
    const costUsd = await costForExtracted(extracted, served);
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
      // An abort reports no usage, but the provider still bills partial work.
      // So `cost_usd` under-reports a hedged call site by about the loser's share.
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
 * `metered()` for streams, whose usage is known only at the end.
 * Wire `finish`, `abort`, and `fail` into the stream hooks. Only the first call counts.
 * Pass `fail` the raw error: status and body exist only on an `APICallError`.
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
        const costUsd = await costForExtracted(extracted, served);
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

/** Bounds a provider that answers a failure with a whole page. */
const MAX_RESPONSE_BODY_CHARS = 2_000;

interface TransportFacts {
  readonly statusCode?: number;
  readonly responseBody?: string;
}

/**
 * Status and body of a failed call, so a 429 can be diagnosed without the provider dashboard.
 * Unwraps ai-retry's `RetryError`. Non-HTTP failures leave both NULL.
 */
function transportFacts(err: unknown): TransportFacts {
  const apiError = findApiCallError(err);

  if (!apiError) return {};
  const body = apiError.responseBody;

  return {
    ...(apiError.statusCode === undefined ? {} : { statusCode: apiError.statusCode }),
    ...(body === undefined ? {} : { responseBody: summarizeBody(body, MAX_RESPONSE_BODY_CHARS) }),
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

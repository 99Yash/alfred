import { serverEnv } from "@alfred/env/server";
import { randomUUID } from "node:crypto";
import { Langfuse } from "langfuse";
import type { CallUsage, MeteredMeta } from "./types";

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
  success(args: { usage?: CallUsage; costUsd: number; output?: unknown }): void;
  error(message: string): void;
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
  // generation() in Langfuse v3 returns an object with .end()/.update().
  // We catch construction errors so a misconfigured SDK can't crash the
  // call site.
  let generation: ReturnType<Langfuse["generation"]> | null = null;
  try {
    generation = client.generation({
      traceId,
      name: meta.name ?? `${meta.provider}/${meta.model}`,
      model: meta.model,
      modelParameters: stripParams(meta.requestMeta),
      startTime: startedAt,
      metadata: {
        kind: meta.kind,
        userId: meta.userId,
        runId: meta.runId,
        stepId: meta.stepId,
        attempt: meta.attempt,
        idempotencyKey: meta.idempotencyKey,
      },
    });
  } catch (err) {
    console.warn("[langfuse] span start failed:", err instanceof Error ? err.message : String(err));
  }

  return {
    success({ usage, costUsd, output }) {
      try {
        generation?.end({
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
          output,
        });
      } catch (err) {
        console.warn("[langfuse] span end failed:", err instanceof Error ? err.message : String(err));
      }
    },
    error(message) {
      try {
        generation?.end({ level: "ERROR", statusMessage: message });
      } catch (err) {
        console.warn("[langfuse] span error end failed:", err instanceof Error ? err.message : String(err));
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
    console.warn("[langfuse] flush failed:", err instanceof Error ? err.message : String(err));
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

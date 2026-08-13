import { flushLangfuse, flushMeteringWrites } from "@alfred/ai";
import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import { registerDispatchToolCallRoundAdapter } from "@alfred/assistant/tool-runtime/dispatch";
import { registerOnUserCreated } from "@alfred/auth";
import { createAssistantRuntime, type AssistantRuntime } from "@alfred/assistant/runtime";
import { assertPersistedCredentialsSealed } from "@alfred/db/credential-vault-maintenance";
import { serverEnv } from "@alfred/env/server";
import { registerBuiltinWorkflows } from "./builtins";

/**
 * Upper bound on the observability flush during shutdown/crash. A stalled
 * network flush (metering rows, Langfuse span batch, Sentry) must never hold
 * teardown open until the platform SIGKILLs — a prompt exit matters more than a
 * straggling cost row or span. Shared by graceful shutdown here and the crash
 * handler in `index.ts` so the two bounds can't drift.
 */
export const OBSERVABILITY_FLUSH_TIMEOUT_MS = 2500;

let runtime: AssistantRuntime | undefined;

/**
 * The one assistant runtime this process drives.
 *
 * `@alfred/assistant/runtime` owns registration order, worker start order and the
 * reverse teardown. This file keeps only what a process owns: the environment
 * read, the authentication hook, the credential boot gate, the recipes that live
 * above the assistant package, and the flush bound it shares with `index.ts`.
 *
 * Built on first use, not at module load: `serverEnv()` throws on an incomplete
 * environment, and a module-scope read moves that failure into every importer,
 * including the ones that never start a runtime.
 */
function assistantRuntime(): AssistantRuntime {
  runtime ??= createAssistantRuntime({
    workerConcurrency: serverEnv().AGENT_WORKER_CONCURRENCY,
    registerRecipes() {
      registerBuiltinWorkflows();
      registerBuiltinTools();
      // Dispatch implements tool-runtime's tool-call-round seam. It is installed at
      // the composition root (not inside registerBuiltinTools) so the built-in leaf
      // holds no dispatch import (ADR-0089); a first executeToolCallRound throws
      // "tool call-round adapter not installed" if this is missing.
      registerDispatchToolCallRoundAdapter();
    },
    registerUserCreated(handler) {
      registerOnUserCreated(handler);
    },
    assertCredentialsReady: assertPersistedCredentialsSealed,
    async flushObservability() {
      // Bound the wait (mirrors the crash handler in `index.ts`): a stalled
      // network flush must not hold graceful shutdown open until the platform
      // SIGKILLs — the pool/Redis close and a prompt exit matter more than a
      // straggling cost row or span batch. `allSettled` so one flush failing
      // doesn't abort the other. `.unref()` the timer so it can never itself keep
      // the event loop alive past the flush it's bounding.
      await Promise.race([
        Promise.allSettled([flushMeteringWrites(), flushLangfuse()]),
        new Promise((resolve) => {
          setTimeout(resolve, OBSERVABILITY_FLUSH_TIMEOUT_MS).unref();
        }),
      ]);
    },
  });
  return runtime;
}

export async function startRuntime(): Promise<void> {
  await assistantRuntime().start();
}

export async function stopRuntime(): Promise<void> {
  await assistantRuntime().stop();
}

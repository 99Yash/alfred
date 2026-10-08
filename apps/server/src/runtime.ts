import { flushLangfuse, flushMeteringWrites } from "@alfred/ai";
import { registerBuiltinTools } from "@alfred/assistant/tool-runtime/builtin-tools";
import { registerDispatchToolCallRoundAdapter } from "@alfred/assistant/tool-runtime/dispatch";
import { registerDefaultContextSources } from "@alfred/assistant/context-search";
import { registerOnUserCreated } from "@alfred/auth";
import { createAssistantRuntime, type AssistantRuntime } from "@alfred/assistant/runtime";
import { assertPersistedCredentialsSealed } from "@alfred/db/credential-vault-maintenance";
import { serverEnv } from "@alfred/env/server";
import { registerBuiltinWorkflows } from "./builtins";

/** Max wait for the observability flush on shutdown or crash. A prompt exit beats a late span. */
export const OBSERVABILITY_FLUSH_TIMEOUT_MS = 2500;

let runtime: AssistantRuntime | undefined;

/**
 * The assistant runtime for this process. Built on first use, because `serverEnv()`
 * throws on an incomplete environment and a module-scope read breaks every importer.
 */
function assistantRuntime(): AssistantRuntime {
  runtime ??= createAssistantRuntime({
    workerConcurrency: serverEnv().AGENT_WORKER_CONCURRENCY,
    registerRecipes() {
      registerBuiltinWorkflows();
      registerBuiltinTools();
      registerDefaultContextSources();
      // Installed here so the built-in tools hold no dispatch import (ADR-0089).
      registerDispatchToolCallRoundAdapter();
    },
    registerUserCreated(handler) {
      registerOnUserCreated(handler);
    },
    assertCredentialsReady: assertPersistedCredentialsSealed,
    async flushObservability() {
      // `.unref()` so the timer itself cannot keep the process alive.
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

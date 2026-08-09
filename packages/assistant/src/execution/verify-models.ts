import { toMessage } from "@alfred/contracts";
import { route, resolveModelContextWindow, type LanguageModel } from "@alfred/ai";

/**
 * Boot-time guard for ADR-0035 (transcript compaction).
 *
 * The compactor derives its threshold from `model_prices.context_window`.
 * If a price row is missing or the column is null for one of the agent
 * models, compaction silently never fires — the boss runs unbounded
 * until the provider hard-fails. Verifying at boot turns that into a
 * loud, immediate failure with a clear remediation (`db:sync-prices`).
 *
 * Verified models cover every surface that consumes a context window:
 *   - `route("boss").model()`  — drives the boss loop in `userAuthoredBriefWorkflow`.
 *   - `route("subAgent").model()` — drives sub-agent runs; same workflow today.
 *   - compactor / compactorFallback routes — the compactor
 *     primitive sizes the prior-transcript payload before calling either.
 */
export async function verifyMeteringModels(): Promise<void> {
  const checks: Array<{ label: string; model: LanguageModel }> = [
    { label: "boss", model: route("boss").model() },
    { label: "sub_agent", model: route("subAgent").model() },
    { label: "compactor", model: route("compactor").model() },
    { label: "compactor_fallback", model: route("compactorFallback").model() },
  ];

  const failures: string[] = [];
  for (const { label, model } of checks) {
    try {
      await resolveModelContextWindow(model);
    } catch (err) {
      const msg = toMessage(err);
      failures.push(`  - ${label}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[verifyMeteringModels] missing context_window for one or more agent models:\n${failures.join("\n")}`,
    );
  }
}

import {
  getBossModel,
  getCheapModel,
  getSubAgentModel,
  resolveModelContextWindow,
  type LanguageModel,
} from "@alfred/ai";

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
 *   - `getBossModel()`  — drives the boss loop in `userAuthoredBriefWorkflow`.
 *   - `getSubAgentModel()` — drives sub-agent runs; same workflow today.
 *   - `getCheapModel()` — the compactor itself; if it can't size its own
 *      input window we have no way to bound the prior-transcript payload.
 */
export async function verifyMeteringModels(): Promise<void> {
  const checks: Array<{ label: string; model: LanguageModel }> = [
    { label: "boss", model: getBossModel() },
    { label: "sub_agent", model: getSubAgentModel() },
    { label: "cheap", model: getCheapModel() },
  ];

  const failures: string[] = [];
  for (const { label, model } of checks) {
    try {
      await resolveModelContextWindow(model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`  - ${label}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[verifyMeteringModels] missing context_window for one or more agent models:\n${failures.join("\n")}`,
    );
  }
}

import { toMessage } from "@alfred/contracts";
import { allRouteLegIdentifiers, resolveContextWindowById } from "@alfred/ai";

/**
 * Boot-time guard for ADR-0035 (transcript compaction).
 *
 * The compactor derives its threshold from `model_prices.context_window`.
 * If a price row is missing or the column is null for one of the agent
 * models, compaction silently never fires — the boss runs unbounded
 * until the provider hard-fails. Verifying at boot turns that into a
 * loud, immediate failure with a clear remediation (`db:sync-prices`).
 *
 * Verified models cover every leg any route can serve
 * (`allRouteLegIdentifiers`), not just the route facades: a facade reports
 * only its primary leg, so verifying facades silently skips every fallback —
 * and a missing fallback row then prices at 0 exactly on the turn the
 * fallback fires.
 */
export async function verifyMeteringModels(): Promise<void> {
  const failures: string[] = [];

  for (const { route, provider, model } of allRouteLegIdentifiers()) {
    try {
      await resolveContextWindowById(provider, model);
    } catch (err) {
      const msg = toMessage(err);
      failures.push(`  - ${route} ${provider}/${model}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[verifyMeteringModels] missing context_window for one or more agent models:\n${failures.join("\n")}`,
    );
  }
}

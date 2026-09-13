import { toMessage } from "@alfred/contracts";
import { allRouteLegIdentifiers, assertLegPriced } from "@alfred/ai";

/**
 * Boot-time guard for metering and for ADR-0035 (transcript compaction).
 *
 * Two silent failures, one guard. A missing `model_prices` row meters the call
 * at $0, and a missing `context_window` stops the compactor from ever firing,
 * so the boss runs unbounded until the provider hard-fails. Verifying at boot
 * turns both into a loud, immediate failure with a clear remediation
 * (`db:sync-prices`).
 *
 * Verified models cover every leg any route can serve
 * (`allRouteLegIdentifiers`), not just the route facades: a facade reports
 * only its primary leg, so verifying facades silently skips every fallback —
 * and a missing fallback row then prices at 0 exactly on the turn the
 * fallback fires.
 *
 * The check is `assertLegPriced`, not `resolveContextWindowById`. The window
 * lookup falls back to a code table that LISTS the fallback legs, so a guard
 * built on it can never fail for the case this guard exists to catch. Read
 * `assertLegPriced` for the two conditions it proves.
 */
export async function verifyMeteringModels(): Promise<void> {
  const failures: string[] = [];

  for (const { route, provider, model } of allRouteLegIdentifiers()) {
    try {
      await assertLegPriced(provider, model);
    } catch (err) {
      const msg = toMessage(err);
      failures.push(`  - ${route} ${provider}/${model}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[verifyMeteringModels] one or more agent model legs are unpriced or unsized:\n${failures.join("\n")}`,
    );
  }
}

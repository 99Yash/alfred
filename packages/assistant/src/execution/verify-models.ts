import { toMessage } from "@alfred/contracts";
import { allRouteLegIdentifiers, assertLegPriced } from "@alfred/ai";

/**
 * Fail at boot if a model leg has no price or context window; the fix is `db:sync-prices`.
 * A missing row meters at $0 or stops compaction. Check every leg, fallbacks included.
 * Use `assertLegPriced`: the window lookup has a code fallback, so it never fails.
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

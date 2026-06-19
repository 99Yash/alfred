import { type RiskTierCounts, useIntegrationTierCounts } from "~/hooks/use-tool-tiers";
import {
  type IntegrationProvider,
  integrationSlugForProvider,
} from "~/lib/integrations/integrations";
import { CapabilityChip } from "./capability-chip";
import { SectionHeading } from "./section-heading";

/**
 * Humanize the registry's tier breakdown into a scannable summary like
 * "3 tools · 1 high, 1 medium, 1 no-risk". Tiers are ordered high→no-risk
 * (most-sensitive first) and zero-count tiers are dropped.
 */
const TIER_ORDER: ReadonlyArray<{ key: keyof RiskTierCounts; label: string }> = [
  { key: "high", label: "high" },
  { key: "medium", label: "medium" },
  { key: "low", label: "low" },
  { key: "no_risk", label: "no-risk" },
];

function summarizeTiers(counts: RiskTierCounts): string {
  const total = counts.no_risk + counts.low + counts.medium + counts.high;
  const parts = TIER_ORDER.flatMap(({ key, label }) =>
    counts[key] > 0 ? [`${counts[key]} ${label}`] : [],
  );
  const noun = total === 1 ? "tool" : "tools";
  return parts.length > 0 ? `${total} ${noun} · ${parts.join(", ")}` : `${total} ${noun}`;
}

export function Capabilities({ provider }: { provider: IntegrationProvider }) {
  const tierCounts = useIntegrationTierCounts(integrationSlugForProvider(provider.id));

  return (
    <section className="space-y-3 app-card-in" style={{ animationDelay: "300ms" }}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionHeading>Capabilities</SectionHeading>
        {tierCounts ? (
          <span className="text-xs text-app-fg-3 tabular-nums">{summarizeTiers(tierCounts)}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {provider.capabilities.map((capability) => (
          <CapabilityChip key={capability}>{capability}</CapabilityChip>
        ))}
      </div>
    </section>
  );
}

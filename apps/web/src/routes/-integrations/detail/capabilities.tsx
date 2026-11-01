import { hasSourceRoute, INTEGRATIONS, type RiskTierCounts } from "@alfred/contracts";
import { useIntegrationTierCounts } from "./use-tool-tiers";
import type { IntegrationPage } from "~/lib/integrations/integrations";
import { CapabilityChip } from "./capability-chip";
import { SectionHeading } from "./section-heading";

/** For "3 tools · 1 high, 1 medium, 1 no-risk": most sensitive first, zero counts dropped. */
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

/**
 * The record chips, from the registry route (ADR-0118 decision 3). A `tools_only` source gets
 * none: the coverage read states that gap where an answer depends on it.
 */
function recordChips(provider: IntegrationPage): ReadonlyArray<string> {
  const { sourceRoutes } = INTEGRATIONS[provider.slug];

  return [
    ...(hasSourceRoute(sourceRoutes, "ingest") ? ["Records Every Event"] : []),
    ...(hasSourceRoute(sourceRoutes, "live") ? ["Searched Live"] : []),
  ];
}

export function Capabilities({ provider }: { provider: IntegrationPage }) {
  const tierCounts = useIntegrationTierCounts(provider.slug);
  const chips = [...provider.capabilities, ...recordChips(provider)];

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "300ms" }}>
      <div className="flex items-baseline justify-between gap-3">
        <SectionHeading>Capabilities</SectionHeading>
        {tierCounts ? (
          <span className="text-xs text-app-fg-3 tabular-nums">{summarizeTiers(tierCounts)}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((capability) => (
          <CapabilityChip key={capability}>{capability}</CapabilityChip>
        ))}
      </div>
    </section>
  );
}

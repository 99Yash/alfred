import type { IntegrationProvider } from "~/lib/integrations";
import { CapabilityChip } from "./capability-chip";
import { SectionHeading } from "./section-heading";

export function Capabilities({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="space-y-3 vs-card-in" style={{ animationDelay: "300ms" }}>
      <SectionHeading>Capabilities</SectionHeading>
      <div className="flex flex-wrap gap-2">
        {provider.capabilities.map((capability) => (
          <CapabilityChip key={capability}>{capability}</CapabilityChip>
        ))}
      </div>
    </section>
  );
}

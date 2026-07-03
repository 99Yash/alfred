import type { Section } from "./helpers";
import { ProviderRow } from "./provider-row";

export function SectionBlock({ section, index }: { section: Section; index: number }) {
  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: `${180 + index * 60}ms` }}>
      <h2 className="px-1 text-xs font-medium tracking-tight text-app-fg-2 uppercase">
        {section.title}
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {section.providers.map((provider, i) => (
          <ProviderRow key={provider.id} provider={provider} index={i} />
        ))}
      </div>
    </section>
  );
}

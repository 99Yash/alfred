import { INTEGRATIONS, type CatalogSlug, type SourceRoute } from "@alfred/contracts";
import { SectionHeading } from "./section-heading";

/** One sentence for each route. A full record, so a new route must get copy. */
const ROUTE_COPY = {
  ingest: (name) => `Alfred stores ${name} events as they arrive.`,
  live: (name) => `Alfred reads ${name} when it searches. It keeps no copy.`,
  tools_only: (name) =>
    `Alfred uses ${name} only through its tools in chat. The activity record has no ${name} events.`,
} satisfies Record<SourceRoute, (name: string) => string>;

/** How this source reaches the activity record (ADR-0118 decision 3), read off the registry entry. */
export function ActivityRecord({ slug, name }: { slug: CatalogSlug; name: string }) {
  return (
    <section className="app-card-in space-y-1" style={{ animationDelay: "320ms" }}>
      <SectionHeading>Activity record</SectionHeading>
      {INTEGRATIONS[slug].sourceRoutes.map((route) => (
        <p key={route} className="text-[12.5px] leading-5 text-app-fg-3">
          {ROUTE_COPY[route](name)}
        </p>
      ))}
    </section>
  );
}

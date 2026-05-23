import type { IntegrationProvider } from "~/lib/integrations";
import { SectionHeading } from "./section-heading";

export function Overview({ provider }: { provider: IntegrationProvider }) {
  return (
    <section className="space-y-4 pb-8 vs-card-in" style={{ animationDelay: "360ms" }}>
      <SectionHeading>Overview</SectionHeading>
      <p className="text-[12.5px] leading-5 text-vs-fg-3">{provider.overview.body}</p>
      <div>
        <h3 className="text-sm font-medium text-vs-fg-4">{provider.overview.heading}</h3>
        <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">{provider.overview.detail}</p>
      </div>
      {provider.overview.extraHeading && provider.overview.extraDetail ? (
        <div>
          <h3 className="text-sm font-medium text-vs-fg-4">{provider.overview.extraHeading}</h3>
          <p className="mt-1 text-[12.5px] leading-5 text-vs-fg-3">
            {provider.overview.extraDetail}
          </p>
        </div>
      ) : null}
    </section>
  );
}

import { Link } from "@tanstack/react-router";
import { getRelatedProviders, type IntegrationProvider } from "~/lib/integrations/integrations";
import { IntegrationIcon } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { SectionHeading } from "./section-heading";

export function RelatedSetup({ provider }: { provider: IntegrationProvider }) {
  const related = getRelatedProviders(provider);
  if (related.length === 0) return null;

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "240ms" }}>
      <div>
        <SectionHeading>Complete your Google setup</SectionHeading>
        <p className="mt-1 text-[12.5px] leading-5 text-app-fg-3">
          To access Docs, Slides, and Sheets, connect each integration.
        </p>
      </div>
      <div className="space-y-2">
        {related.map((item, idx) => (
          <Link
            key={item.id}
            to="/integrations/$provider"
            params={{ provider: item.id }}
            className={cn(
              "app-card-in flex items-center gap-3 rounded-2xl bg-app-bg-1 px-3 py-2.5",
              "app-press shadow-[var(--app-shadow-elevated)] transition-shadow",
              "hover:shadow-[var(--app-shadow-elevated-hover)]",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
            )}
            style={{ animationDelay: `${260 + idx * 40}ms` }}
          >
            <IntegrationIcon brand={item.brand} size="md" title={item.name} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-app-fg-4">{item.name}</p>
              <p className="truncate text-[12.5px] text-app-fg-3">{item.description}</p>
            </div>
            <span
              className={cn(
                "inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium",
                "bg-app-bg-2 text-app-fg-4 ring-1 ring-app-bg-3",
              )}
            >
              {item.actionLabel}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

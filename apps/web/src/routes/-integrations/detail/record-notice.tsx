import { History } from "lucide-react";
import { hasSourceRoute, INTEGRATIONS, type CatalogSlug } from "@alfred/contracts";
import { AppCard } from "~/components/ui/v2";
import { SectionHeading } from "./section-heading";

/** What Alfred keeps from this source, from its registry route (ADR-0118 decision 3). */
export function RecordNotice({ slug, name }: { slug: CatalogSlug; name: string }) {
  const { routes } = INTEGRATIONS[slug];
  const ingest = hasSourceRoute(routes, "ingest");
  const live = hasSourceRoute(routes, "live");

  const title = ingest
    ? "Alfred records every event."
    : live
      ? "Alfred reads it when it searches."
      : "Alfred keeps no record.";

  const lines = [
    ingest &&
      `Each ${name} event is kept with its time. Your briefing and search can see what happened, and when.`,
    live &&
      `Alfred keeps no copy of ${name}. It reads ${name} at search time, so a removed share stops counting at once.`,
    !ingest &&
      !live &&
      `Alfred stores no events from ${name}. It reads ${name} only when you ask in chat, so your briefing cannot see what happened there.`,
  ];

  const body = lines.filter(Boolean).join(" ");

  return (
    <section className="app-card-in space-y-3" role="note" style={{ animationDelay: "240ms" }}>
      <SectionHeading>Activity record</SectionHeading>

      <AppCard className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-control bg-app-bg-2 text-app-fg-3"
        >
          <History size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-app-fg-4">{title}</p>
          <p className="mt-1 text-[12.5px] leading-5 text-app-fg-3">{body}</p>
        </div>
      </AppCard>
    </section>
  );
}

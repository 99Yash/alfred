import { Compass } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { SectionHeading } from "./section-heading";

/**
 * The render-site marker for a planned integration (ADR-0093). A planned
 * provider has no backend route and no tool, so the surfaces that imply a live
 * connection — the connected-accounts table, the approval-policy control (a
 * persisted write for a no-op integration), the trust notice, the capability
 * chips, and the raw receipt inventory — are omitted and this notice takes
 * their place.
 */
export function DesignOnlyNotice({ name }: { name: string }) {
  return (
    <section className="app-card-in space-y-3" role="note" style={{ animationDelay: "120ms" }}>
      <SectionHeading>Design-only preview</SectionHeading>

      <AppCard className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3"
        >
          <Compass size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-app-fg-4">{name} is not available yet.</p>
          <p className="mt-1 text-[12.5px] leading-5 text-app-fg-3">
            This integration has no backend connection, tools, or approval policy. The page is shown
            for reference only; nothing here is actionable.
          </p>
        </div>
      </AppCard>
    </section>
  );
}

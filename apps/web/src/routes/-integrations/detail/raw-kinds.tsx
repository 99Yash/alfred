import { AppCard } from "~/components/ui/v2";
import type { IntegrationPage } from "~/lib/integrations/integrations";
import { formatRelative } from "~/lib/strings";
import { ColumnLabel } from "./column-label";
import { SectionHeading } from "./section-heading";
import { useRawReceiptKinds } from "./use-raw-kinds";

/**
 * Every event kind this provider has delivered that Alfred stores but does not
 * yet act on (ADR-0097 item 9). A new provider resource shows up here the day
 * it starts to arrive. Renders nothing when there are none.
 */
export function RawKinds({ provider }: { provider: IntegrationPage }) {
  const kinds = useRawReceiptKinds(provider.slug);
  if (kinds.length === 0) return null;

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "330ms" }}>
      <div className="space-y-1">
        <SectionHeading>Unmapped events</SectionHeading>
        <p className="text-[12.5px] leading-5 text-app-fg-3">
          Delivered and stored. Nothing reacts to these yet.
        </p>
      </div>

      <AppCard padded={false} className="overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-app-bg-3/60 px-4 pt-3 pb-2">
          <ColumnLabel>Kind</ColumnLabel>
          <ColumnLabel>Count</ColumnLabel>
          <ColumnLabel>Last seen</ColumnLabel>
        </div>
        {kinds.map((entry) => (
          <div
            key={entry.kind}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-2.5"
          >
            <p className="min-w-0 truncate font-mono text-[12.5px] text-app-fg-4">{entry.kind}</p>
            <p className="text-sm text-app-fg-3 tabular-nums">{entry.count}</p>
            <p className="text-sm text-app-fg-3 tabular-nums">{formatRelative(entry.lastSeenAt)}</p>
          </div>
        ))}
      </AppCard>
    </section>
  );
}

import { AppButton, AppCard } from "~/components/ui/v2";
import type { InboundEventSource } from "@alfred/contracts";
import { formatRelative } from "~/lib/strings";
import { ColumnLabel } from "./column-label";
import { SectionHeading } from "./section-heading";
import { useRawReceiptKinds } from "~/lib/integrations/use-raw-kinds";

/**
 * Every event kind this provider has delivered that no built-in flow acts on
 * (ADR-0097 item 9). A new provider resource shows up here the day it starts
 * to arrive, with explicit loading, error, and empty states. A workflow can
 * subscribe to any kind listed here from its editor (#990).
 */
export function RawKinds({ slug }: { slug: InboundEventSource }) {
  const query = useRawReceiptKinds(slug);
  const kinds = query.data?.kinds ?? [];

  return (
    <section className="app-card-in space-y-3" style={{ animationDelay: "330ms" }}>
      <div className="space-y-1">
        <SectionHeading>Unmapped events</SectionHeading>
        <p className="text-[12.5px] leading-5 text-app-fg-3">
          Stored for search. A workflow can subscribe to any of these kinds from its editor.
        </p>
      </div>

      {query.data && (
        <p className="text-[12.5px] leading-5 text-app-fg-3">
          Search limit: {query.data.embedding.dailyCap.toLocaleString()} events per day in your time
          zone. {query.data.embedding.cappedCount.toLocaleString()} stored events were kept out of
          search because they exceeded this limit.
        </p>
      )}

      {query.isPending ? (
        <p role="status" className="text-sm text-app-fg-3">
          Loading events…
        </p>
      ) : query.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-app-fg-3">Could not load events.</p>
          <AppButton
            variant="ghost"
            size="sm"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </AppButton>
        </div>
      ) : kinds.length === 0 ? (
        <p className="text-sm text-app-fg-3">No unmapped events have been stored.</p>
      ) : (
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
              <p className="text-sm text-app-fg-3 tabular-nums">
                {formatRelative(entry.lastSeenAt)}
              </p>
            </div>
          ))}
        </AppCard>
      )}
    </section>
  );
}

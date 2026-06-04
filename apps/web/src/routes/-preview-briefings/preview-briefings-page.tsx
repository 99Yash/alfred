import { Link } from "@tanstack/react-router";
import { ChevronRight, Sparkles } from "lucide-react";
import type { SyncedBriefing } from "@alfred/sync";
import { VsCard } from "~/components/ui/visitors";
import { useBriefings } from "~/lib/replicache/use-briefings";
import { briefingPlainText } from "./briefing-prose";
import { formatDayHeading, slotLabel } from "./briefing-utils";

/** Group the (already newest-first, morning-before-evening) rows by day, preserving order. */
function groupByDate(briefings: SyncedBriefing[]): { date: string; slots: SyncedBriefing[] }[] {
  const groups: { date: string; slots: SyncedBriefing[] }[] = [];
  for (const b of briefings) {
    const last = groups[groups.length - 1];
    if (last && last.date === b.briefingDate) last.slots.push(b);
    else groups.push({ date: b.briefingDate, slots: [b] });
  }
  return groups;
}

/** One-line gist of a slot for the timeline; falls back to a status note. */
function slotGist(b: SyncedBriefing): string {
  if (b.breakingSummary) return briefingPlainText(b.breakingSummary, b.gather);
  if (b.status === "suppressed") return "Quiet day — not emailed.";
  return "Not composed yet.";
}

/**
 * Reverse-chronological timeline of the synced briefings (ADR-0049). Reads the
 * Replicache 30-day window only — an honest boundary line sits at the bottom;
 * the >30-day archive route is deferred. Each day links to its detail; an empty
 * account shows a calm first-run state.
 */
export function PreviewBriefingsPage() {
  const { briefings, loading, error, retry } = useBriefings();
  const days = groupByDate(briefings);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-10 sm:py-14">
        <header className="space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-balance text-vs-fg-4">
            Briefings
          </h1>
          <p className="mx-auto max-w-[40rem] text-sm text-vs-fg-3">
            Your daily orientation and close, kept day by day.
          </p>
        </header>

        {error ? (
          <VsCard className="mt-10 flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <p className="text-sm font-medium text-vs-fg-4">Briefings could not sync</p>
            <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">{error}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-1 rounded-lg bg-vs-bg-2 px-3 py-1.5 text-xs font-medium text-vs-fg-4 outline-none transition-colors hover:bg-vs-bg-3 focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background"
            >
              Retry
            </button>
          </VsCard>
        ) : days.length > 0 ? (
          <>
            <VsCard padded={false} className="mt-10">
              <ul className="divide-y divide-vs-bg-3">
                {days.map(({ date, slots }) => (
                  <li key={date}>
                    <Link
                      to="/briefings/$date"
                      params={{ date }}
                      className="group flex items-center gap-4 px-5 py-4 outline-none transition-colors hover:bg-vs-bg-a1 focus-visible:bg-vs-bg-2"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <h2 className="text-sm font-medium text-vs-fg-4">
                          {formatDayHeading(date)}
                        </h2>
                        <div className="space-y-1">
                          {slots.map((slot) => (
                            <div key={slot.id} className="flex items-baseline gap-2.5">
                              <span className="w-[52px] shrink-0 text-[11px] font-medium uppercase tracking-tight text-vs-fg-2">
                                {slotLabel(slot.slot)}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-vs-fg-3">
                                {slotGist(slot)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <ChevronRight
                        size={16}
                        aria-hidden
                        className="shrink-0 text-vs-fg-1 transition-colors group-hover:text-vs-fg-3"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </VsCard>
            <p className="mt-6 text-center text-xs text-vs-fg-2">Showing the last 30 days.</p>
          </>
        ) : (
          <VsCard className="mt-10 flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span
              className="grid size-10 place-items-center rounded-xl bg-vs-bg-2 text-vs-fg-3"
              aria-hidden
            >
              <Sparkles size={18} />
            </span>
            <p className="text-sm font-medium text-vs-fg-4">
              {loading ? "Loading briefings…" : "No briefings yet"}
            </p>
            {!loading ? (
              <p className="max-w-[28rem] text-xs leading-5 text-vs-fg-3">
                Alfred composes a briefing each morning and evening. The first one arrives tomorrow.
              </p>
            ) : null}
          </VsCard>
        )}
      </main>
    </div>
  );
}

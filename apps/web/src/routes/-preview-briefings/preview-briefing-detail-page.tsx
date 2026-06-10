import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppCard } from "~/components/ui/v2";
import { useBriefing } from "~/lib/replicache/use-briefings";
import { cn } from "~/lib/utils";
import { BriefingSlot } from "./briefing-slot";
import { formatDayHeading } from "./briefing-utils";

/**
 * A day's briefing detail (ADR-0049): morning above evening, both visible
 * (not tabbed — a day reads orientation → close top-to-bottom). Day-keyed via a
 * `briefing/{date}/` prefix scan, so the URL stays human and shareable while
 * the per-slot Replicache key is an implementation detail.
 */
export function PreviewBriefingDetailPage() {
  const { date } = useParams({ from: "/briefings/$date" });
  const { slots, loading, error, retry } = useBriefing(date);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto scroll-stable">
      <main className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-10 sm:py-16">
        <div className="space-y-6">
          <Link
            to="/briefings"
            className={cn(
              "inline-flex items-center gap-2 text-sm text-app-fg-3",
              "transition-colors hover:text-app-fg-4",
              "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background rounded",
            )}
          >
            <ArrowLeft size={14} />
            All briefings
          </Link>

          <header>
            <h1 className="text-[32px] leading-[38px] font-medium tracking-tight text-balance text-app-fg-4">
              {formatDayHeading(date)}
            </h1>
          </header>

          {error ? (
            <AppCard className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <p className="text-sm font-medium text-app-fg-4">Briefing could not sync</p>
              <p className="max-w-md text-xs leading-5 text-app-fg-3">{error}</p>
              <button
                type="button"
                onClick={retry}
                className="mt-1 rounded-lg bg-app-bg-2 px-3 py-1.5 text-xs font-medium text-app-fg-4 outline-none transition-colors hover:bg-app-bg-3 focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background"
              >
                Retry
              </button>
            </AppCard>
          ) : slots.length > 0 ? (
            <div className="space-y-4">
              {slots.map((briefing) => (
                <BriefingSlot key={briefing.id} briefing={briefing} />
              ))}
            </div>
          ) : (
            <AppCard className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <p className="text-sm font-medium text-app-fg-4">
                {loading ? "Loading briefing…" : "No briefing for this day"}
              </p>
              {!loading ? (
                <p className="max-w-md text-xs leading-5 text-app-fg-3">
                  Nothing is synced for {date}. Briefings older than 30 days aren't kept on this
                  device.
                </p>
              ) : null}
            </AppCard>
          )}
        </div>
      </main>
    </div>
  );
}

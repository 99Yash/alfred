import { ArrowRight, Sparkles } from "lucide-react";
import { cn } from "~/lib/utils";
import type { RailBriefingSummary } from "./rail-content";

/**
 * Rail footer CTA. Two variants:
 *
 *   - **Empty.** No composed briefing for the user yet. The CTA still
 *     reads "Morning briefing" with a quiet secondary line so the rail's
 *     bottom anchor stays consistent.
 *   - **Latest.** Shows the briefing's slot + when it ran ("Morning ·
 *     8:42 AM"). Click is a no-op for now — a "view briefing" surface
 *     is a follow-up; the CTA's first job is to surface that briefings
 *     are running.
 */
export function RailFooter({ latestBriefing }: { latestBriefing: RailBriefingSummary | null }) {
  const secondary = latestBriefing ? formatBriefingSubtitle(latestBriefing) : "No briefing yet";

  return (
    <div className="shrink-0 p-3 border-t border-white/10">
      <button
        type="button"
        aria-label={latestBriefing ? `View briefing from ${secondary}` : "Morning briefing"}
        className={cn(
          "w-full inline-flex items-center justify-between gap-3 rounded-xl px-3 py-2",
          "text-left",
          "text-[var(--vs-accent-fg)]",
          "bg-[image:var(--vs-cta-bg)]",
          "shadow-[var(--vs-button-primary-shadow)]",
          "vs-press transition-[box-shadow,transform,filter]",
          "hover:brightness-[1.06]",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <Sparkles size={13} aria-hidden className="shrink-0" />
          <span className="min-w-0 flex flex-col">
            <span className="text-[13px] font-medium leading-tight truncate">Morning briefing</span>
            <span className="text-[11px] leading-tight opacity-80 truncate">{secondary}</span>
          </span>
        </span>
        <ArrowRight size={14} aria-hidden className="shrink-0 opacity-90" />
      </button>
    </div>
  );
}

/**
 * Pick the most useful subtitle for the CTA. Same-day briefings get a
 * time ("Morning · 8:42 AM"), older ones get a date ("Morning · May 22").
 * Slot is capitalized for headline weight.
 */
function formatBriefingSubtitle(b: RailBriefingSummary): string {
  const slot = capitalize(b.slot);
  const ran = new Date(b.runAt);
  if (Number.isNaN(ran.getTime())) return slot;
  const today = new Date();
  const sameDay =
    ran.getFullYear() === today.getFullYear() &&
    ran.getMonth() === today.getMonth() &&
    ran.getDate() === today.getDate();
  if (sameDay) {
    const time = ran.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${slot} · ${time}`;
  }
  const date = ran.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${slot} · ${date}`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

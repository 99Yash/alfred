import { Link } from "@tanstack/react-router";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "~/lib/utils";
import type { RailBriefingSummary } from "./rail-data";

const CTA_CLASS = cn(
  "w-full inline-flex items-center justify-between gap-3 rounded-xl px-3 py-2",
  "text-left",
  "text-[var(--app-accent-fg)]",
  "bg-[image:var(--app-cta-bg)]",
  "shadow-[var(--app-button-primary-shadow)]",
  "app-press transition-[box-shadow,transform,filter]",
  "hover:brightness-[1.06]",
  "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
);

/**
 * Rail footer CTA (ADR-0049). Three states:
 *
 *   - **Latest.** A composed briefing exists for today — shows its slot +
 *     when it ran ("Evening · 8:42 AM") and deep-links to that day's detail
 *     (`/briefings/{date}`).
 *   - **Composing.** A manual run is queued/in flight — reads "Composing
 *     briefing" with a spinner; disabled until the chip flips to Latest.
 *   - **Empty.** No briefing today. With `onGenerate` (the live chat shell),
 *     it's a "Generate briefing" button that triggers an on-demand run.
 *     Without it (the preview route), it links to the briefings timeline so
 *     the rail's bottom anchor stays consistent.
 */
export function RailFooter({
  latestBriefing,
  onGenerate,
  pending = false,
}: {
  latestBriefing: RailBriefingSummary | null;
  onGenerate?: () => void;
  pending?: boolean;
}) {
  // Title tracks the latest briefing's slot ("Evening briefing"); the empty
  // state offers to generate, the in-flight state reports progress.
  const title = latestBriefing
    ? `${capitalize(latestBriefing.slot)} briefing`
    : pending
      ? "Composing briefing"
      : onGenerate
        ? "Generate briefing"
        : "Morning briefing";

  const secondary = latestBriefing
    ? formatBriefingSubtitle(latestBriefing)
    : pending
      ? "Working on it. This takes a minute."
      : onGenerate
        ? "Compose today's briefing now"
        : "No briefing yet";

  const inner = (
    <>
      <span className="inline-flex min-w-0 items-center gap-2">
        <Sparkles size={13} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex flex-col">
          <span className="text-[13px] font-medium leading-tight truncate">{title}</span>
          <span className="text-[11px] leading-tight opacity-80 truncate">{secondary}</span>
        </span>
      </span>
      {pending ? (
        <Loader2 size={14} aria-hidden className="shrink-0 opacity-90 animate-spin" />
      ) : (
        <ArrowRight size={14} aria-hidden className="shrink-0 opacity-90" />
      )}
    </>
  );

  return (
    <div className="shrink-0 p-3 border-t border-white/10">
      {latestBriefing ? (
        <Link
          to="/briefings/$date"
          params={{ date: latestBriefing.briefingDate }}
          aria-label={`View briefing from ${secondary}`}
          className={CTA_CLASS}
        >
          {inner}
        </Link>
      ) : onGenerate ? (
        <button
          type="button"
          onClick={onGenerate}
          disabled={pending}
          aria-label={pending ? "Composing briefing" : "Generate today's briefing"}
          className={cn(CTA_CLASS, pending && "opacity-80 cursor-default hover:brightness-100")}
        >
          {inner}
        </button>
      ) : (
        <Link to="/briefings" aria-label="View briefings" className={CTA_CLASS}>
          {inner}
        </Link>
      )}
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

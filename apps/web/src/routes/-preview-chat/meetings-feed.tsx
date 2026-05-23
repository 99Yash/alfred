import { cn } from "~/lib/utils";
import { MEETINGS, type MeetingItem } from "./helpers";
import { RailSection } from "./rail-section";
import { SuggestionRow } from "./suggestion-row";

export function MeetingsFeed() {
  return (
    <div className="vs-card-in space-y-2">
      <div className="px-1 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
        Today · {MEETINGS.length}
      </div>
      <ul className="space-y-1">
        {MEETINGS.map((meeting) => (
          <MeetingRow key={meeting.id} meeting={meeting} />
        ))}
      </ul>

      <RailSection title="After today">
        <SuggestionRow label="Mon · Board prep with Priya" detail="09:30 · 60m" />
        <SuggestionRow label="Tue · Vendor demo" detail="14:00 · 45m" />
      </RailSection>
    </div>
  );
}

function MeetingRow({ meeting }: { meeting: MeetingItem }) {
  const isNext = meeting.status === "next";
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 inline-flex flex-col items-center justify-center shrink-0 rounded-md",
            "h-10 w-10 leading-none",
            isNext
              ? "bg-vs-amber-1 text-vs-amber-4 ring-1 ring-vs-amber-2"
              : "bg-vs-bg-2 text-vs-fg-3",
          )}
        >
          <span className="text-[11px] font-semibold tabular-nums">{meeting.time}</span>
          <span className="mt-0.5 text-[9px] uppercase tracking-tight text-vs-fg-2">
            {meeting.duration}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-5 font-medium text-vs-fg-4">
              {meeting.title}
            </span>
            {isNext ? (
              <span
                aria-hidden
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5",
                  "text-[9.5px] uppercase tracking-tight font-medium",
                  "bg-vs-amber-1 text-vs-amber-4",
                )}
              >
                Next
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[11px] leading-4 text-vs-fg-2">
            {meeting.with}
          </span>
        </span>
      </button>
    </li>
  );
}

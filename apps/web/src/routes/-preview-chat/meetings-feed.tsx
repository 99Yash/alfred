import { cn } from "~/lib/utils";
import type { MeetingItem } from "./helpers";
import { RailSection } from "./rail-section";
import { SuggestionRow } from "./suggestion-row";

export interface MeetingLookaheadItem {
  label: string;
  detail: string;
}

const EMPTY_LOOKAHEAD: ReadonlyArray<MeetingLookaheadItem> = [];

export function MeetingsFeed({
  items,
  lookahead = EMPTY_LOOKAHEAD,
  calendarConnected = false,
}: {
  items: ReadonlyArray<MeetingItem>;
  lookahead?: ReadonlyArray<MeetingLookaheadItem>;
  /**
   * Did the user actually grant the Calendar scope? An empty `items` list
   * means either "no calendar connected" or "calendar is connected, but
   * the day is genuinely clear" — copy diverges between the two.
   */
  calendarConnected?: boolean;
}) {
  if (!items.length && !lookahead.length) {
    return (
      <div className="vs-card-in px-2 py-4">
        <p className="text-[12px] leading-5 text-vs-fg-2">
          {calendarConnected
            ? "Nothing on your calendar today."
            : "Connect Google Calendar to see your day at a glance."}
        </p>
      </div>
    );
  }

  return (
    <div className="vs-card-in space-y-2">
      {items.length ? (
        <>
          <div className="px-1 text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
            Today · {items.length}
          </div>
          <ul className="space-y-1">
            {items.map((meeting) => (
              <MeetingRow key={meeting.id} meeting={meeting} />
            ))}
          </ul>
        </>
      ) : null}

      {lookahead.length ? (
        <RailSection title="After today">
          {lookahead.map((l) => (
            <SuggestionRow key={l.label} label={l.label} detail={l.detail} />
          ))}
        </RailSection>
      ) : null}
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
          <span className="block truncate text-[11px] leading-4 text-vs-fg-2">{meeting.with}</span>
        </span>
      </button>
    </li>
  );
}

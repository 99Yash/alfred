import { cn } from "~/lib/utils";
import type { RailMeetingItem } from "./models";
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
  items: ReadonlyArray<RailMeetingItem>;
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
      <div className="app-card-in px-2 py-4">
        <p className="text-[12px] leading-5 text-white/55">
          {calendarConnected
            ? "Nothing on your calendar today."
            : "Connect Google Calendar to see your day at a glance."}
        </p>
      </div>
    );
  }

  return (
    <div className="app-card-in space-y-2">
      {items.length ? (
        <>
          <div className="px-1 text-[10.5px] font-medium tracking-tight text-white/55 uppercase">
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

function MeetingRow({ meeting }: { meeting: RailMeetingItem }) {
  const isNext = meeting.status === "next";
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group -mx-0.5 w-full rounded-xl p-2 text-left",
          "app-press transition-colors hover:bg-white/[0.07]",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 inline-flex shrink-0 flex-col items-center justify-center rounded-md",
            "size-10 leading-none",
            isNext
              ? "bg-app-amber-1 text-app-amber-4 ring-1 ring-app-amber-2"
              : "bg-white/10 text-white/70",
          )}
        >
          <span className="text-[11px] font-semibold tabular-nums">{meeting.time}</span>
          <span className="mt-0.5 text-[9px] tracking-tight text-white/55 uppercase">
            {meeting.duration}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] leading-5 font-medium text-white">
              {meeting.title}
            </span>
            {isNext ? (
              <span
                aria-hidden
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-0.5",
                  "text-[9.5px] font-medium tracking-tight uppercase",
                  "bg-app-amber-1 text-app-amber-4",
                )}
              >
                Next
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[11px] leading-4 text-white/55">{meeting.with}</span>
        </span>
      </button>
    </li>
  );
}

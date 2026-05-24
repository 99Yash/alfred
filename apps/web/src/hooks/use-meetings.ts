import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";
import type { MeetingItem } from "~/routes/-preview-chat/helpers";

/**
 * Today's calendar events for the rail's Meetings tab. Mirrors `useInbox`:
 * a 401, an empty 200, or a credential without the Calendar scope all
 * surface as `items = []`, and `MeetingsFeed` renders the appropriate
 * empty state.
 *
 * The response also carries a `connected` flag so the empty state can
 * distinguish "no calendar connected" from "calendar connected, just
 * a clear day."
 */
export interface UseMeetingsResult {
  items: ReadonlyArray<MeetingItem>;
  connected: boolean;
}

export function useMeetings() {
  return useQuery<UseMeetingsResult>({
    queryKey: ["me", "meetings"],
    queryFn: async () => {
      const res = await client.api.me.meetings.get();
      if (res.error || !res.data) return { items: [], connected: false };
      const raw = res.data.items as ReadonlyArray<MeetingResponseItem>;
      // Pick exactly one row to badge as "next" — the soonest future event.
      // Without this, every future event would render with the Next pill
      // and the rail's signal value evaporates.
      const now = Date.now();
      let nextStart: number | null = null;
      for (const r of raw) {
        const parsed = r.startAt ? new Date(r.startAt).getTime() : Number.POSITIVE_INFINITY;
        const start = Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
        if (start > now && (nextStart === null || start < nextStart)) {
          nextStart = start;
        }
      }
      const items = raw.map((r) => toMeetingItem(r, nextStart));
      return { items, connected: Boolean(res.data.connected) };
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

interface MeetingResponseItem {
  id: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  attendees: ReadonlyArray<{ email: string; displayName: string | null }>;
  hangoutLink: string | null;
  htmlLink: string | null;
}

function toMeetingItem(row: MeetingResponseItem, nextStart: number | null): MeetingItem {
  const time = row.allDay ? "All day" : formatStart(row.startAt);
  const duration = row.allDay ? "" : formatDuration(row.startAt, row.endAt);
  return {
    id: row.id,
    title: row.title,
    time,
    duration,
    with: formatWith(row.attendees),
    status: statusFor(row.startAt, row.endAt, nextStart),
  };
}

function formatStart(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // HH:mm in the user's local TZ. Calendar API returns RFC3339 with the
  // event's original tz offset, which the Date constructor normalises.
  const hours = d.getHours().toString().padStart(2, "0");
  const minutes = d.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return "";
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return "";
  const mins = Math.round((end - start) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

function formatWith(
  attendees: ReadonlyArray<{ email: string; displayName: string | null }>,
): string {
  if (attendees.length === 0) return "Solo";
  if (attendees.length === 1) {
    const a = attendees[0]!;
    return a.displayName ?? a.email.split("@")[0] ?? a.email;
  }
  return `${attendees.length} people`;
}

/**
 * Highlight the meeting most relevant to "right now":
 *  - now    → currently happening
 *  - next   → the soonest upcoming event of the day (exactly one row)
 *  - later  → everything else, including past
 *
 * The rail UI only colours `next` and `now` rows; `later` reads as plain.
 */
function statusFor(
  startIso: string | null,
  endIso: string | null,
  nextStart: number | null,
): "now" | "next" | "later" | undefined {
  if (!startIso) return undefined;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return undefined;
  const end = endIso ? new Date(endIso).getTime() : start;
  const now = Date.now();
  if (start <= now && now < end) return "now";
  if (start === nextStart) return "next";
  return "later";
}

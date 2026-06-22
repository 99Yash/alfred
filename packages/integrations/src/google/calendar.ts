import { httpErrorFromResponse } from "@alfred/contracts";
import { z } from "zod";

/**
 * Thin Google Calendar v3 REST client. Same shape as `gmail.ts` —
 * we call JSON endpoints directly so we don't pull `googleapis` (~2MB).
 *
 * The current surface covers what chat/workflows need first: list event
 * windows from the primary calendar and create approved events. Anything
 * fancier (multi-calendar discovery, free/busy, recurring edits) waits
 * until a workflow asks for it.
 */

const API_BASE = "https://www.googleapis.com/calendar/v3";

const eventDateTimeSchema = z.object({
  /** RFC3339 timestamp e.g. `2026-05-24T10:00:00-07:00`. Present on timed events. */
  dateTime: z.string().optional(),
  /** YYYY-MM-DD. Present on all-day events. */
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const attendeeSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
  responseStatus: z.string().optional(),
});

const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventDateTimeSchema.optional(),
  end: eventDateTimeSchema.optional(),
  attendees: z.array(attendeeSchema).optional(),
  hangoutLink: z.string().optional(),
  htmlLink: z.string().optional(),
});

export type CalendarEvent = z.infer<typeof eventSchema>;
export type CalendarAttendee = z.infer<typeof attendeeSchema>;

const listEventsResponseSchema = z.object({
  items: z.array(eventSchema).optional(),
  nextPageToken: z.string().optional(),
  timeZone: z.string().optional(),
});

export interface ListEventsArgs {
  accessToken: string;
  /** Calendar id; `primary` is the user's main calendar. */
  calendarId?: string;
  /** RFC3339 lower bound (inclusive). */
  timeMin: string;
  /** RFC3339 upper bound (exclusive). */
  timeMax: string;
  /**
   * Expand recurring events into instances so e.g. a daily standup
   * surfaces as one row per occurrence. The list endpoint refuses
   * `orderBy=startTime` unless this is set.
   */
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
  maxResults?: number;
}

export interface ListEventsResult {
  events: CalendarEvent[];
  /** Effective timezone the calendar returned (helpful for downstream formatting). */
  timeZone?: string;
}

export async function listEvents(args: ListEventsArgs): Promise<ListEventsResult> {
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  const url = new URL(`${API_BASE}/calendars/${calendarId}/events`);
  url.searchParams.set("timeMin", args.timeMin);
  url.searchParams.set("timeMax", args.timeMax);
  const singleEvents = args.singleEvents ?? true;
  url.searchParams.set("singleEvents", String(singleEvents));
  // Calendar API rejects `orderBy=startTime` unless `singleEvents=true`, so
  // the default flips with `singleEvents`. Callers that explicitly pass
  // `startTime` + `singleEvents=false` still get a 400 from upstream — by
  // design, we don't second-guess an explicit caller request.
  const orderBy = args.orderBy ?? (singleEvents ? "startTime" : "updated");
  url.searchParams.set("orderBy", orderBy);
  url.searchParams.set("maxResults", String(args.maxResults ?? 50));

  const json = await getJson(url.toString(), args.accessToken);
  const parsed = listEventsResponseSchema.parse(json);
  // Filter out cancelled occurrences so callers don't need to special-case them.
  const events = (parsed.items ?? []).filter((e) => e.status !== "cancelled");
  return { events, timeZone: parsed.timeZone };
}

export interface CreateEventArgs {
  accessToken: string;
  /** Calendar id; `primary` is the user's main calendar. */
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  /** RFC3339 start timestamp. */
  start: string;
  /** RFC3339 end timestamp. */
  end: string;
  /** IANA timezone. Optional when start/end carry explicit offsets. */
  timeZone?: string;
  attendees?: string[];
}

export async function createEvent(args: CreateEventArgs): Promise<CalendarEvent> {
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  const url = new URL(`${API_BASE}/calendars/${calendarId}/events`);
  if (args.attendees && args.attendees.length > 0) {
    url.searchParams.set("sendUpdates", "all");
  }

  const payload = {
    summary: args.summary,
    description: args.description,
    location: args.location,
    start: {
      dateTime: args.start,
      timeZone: args.timeZone,
    },
    end: {
      dateTime: args.end,
      timeZone: args.timeZone,
    },
    attendees: args.attendees?.map((email) => ({ email })),
  };
  const json = await postJson(url.toString(), args.accessToken, payload);
  return eventSchema.parse(json);
}

const CALENDAR_FETCH_TIMEOUT_MS = 30_000;

async function getJson(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(CALENDAR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("calendar", res, { url });
  }
  return await res.json();
}

async function postJson(url: string, accessToken: string, payload: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(CALENDAR_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw await httpErrorFromResponse("calendar", res, { url, method: "POST" });
  }
  return await res.json();
}

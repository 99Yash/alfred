import { calendarCreateEventSendsInvitations } from "@alfred/contracts";
import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { googleJson } from "./http";

/** Calendar v3 client: list events and create approved events. */

const API_BASE = "https://www.googleapis.com/calendar/v3";

const eventDateTimeSchema = z.object({
  /** RFC3339. Present on timed events. */
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
  calendarId?: string | undefined;
  /** Inclusive. */
  timeMin: string;
  /** Exclusive. */
  timeMax: string;
  /** Expand recurring events into instances. Required for `orderBy=startTime`. */
  singleEvents?: boolean | undefined;
  orderBy?: "startTime" | "updated" | undefined;
  maxResults?: number | undefined;
}

export interface ListEventsResult {
  events: CalendarEvent[];
  timeZone?: string | undefined;
}

export async function listEvents(
  args: ListEventsArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<ListEventsResult> {
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  const url = new URL(`${API_BASE}/calendars/${calendarId}/events`);
  url.searchParams.set("timeMin", args.timeMin);
  url.searchParams.set("timeMax", args.timeMax);
  const singleEvents = args.singleEvents ?? true;
  url.searchParams.set("singleEvents", String(singleEvents));
  // `startTime` requires `singleEvents=true`. An explicit bad pair gets Google's 400.
  const orderBy = args.orderBy ?? (singleEvents ? "startTime" : "updated");
  url.searchParams.set("orderBy", orderBy);
  url.searchParams.set("maxResults", String(args.maxResults ?? 50));

  const parsed = await getJson(listEventsResponseSchema, url.toString(), args.accessToken, retry);
  const events = (parsed.items ?? []).filter((e) => e.status !== "cancelled");

  return { events, timeZone: parsed.timeZone };
}

export interface CreateEventArgs {
  accessToken: string;
  calendarId?: string | undefined;
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  start: string;
  end: string;
  /** Optional when start and end carry offsets. */
  timeZone?: string | undefined;
  attendees?: string[] | undefined;
}

export async function createEvent(args: CreateEventArgs): Promise<CalendarEvent> {
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  const url = new URL(`${API_BASE}/calendars/${calendarId}/events`);

  if (calendarCreateEventSendsInvitations(args)) {
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

  return postJson(eventSchema, url.toString(), args.accessToken, payload);
}

const getJson = <T>(
  schema: z.ZodType<T>,
  url: string,
  accessToken: string,
  retry: RetryPolicy | "none",
): Promise<T> =>
  googleJson("calendar", "GET", url, accessToken, undefined, retry).then((raw) =>
    schema.parse(raw),
  );

const postJson = <T>(
  schema: z.ZodType<T>,
  url: string,
  accessToken: string,
  payload: unknown,
): Promise<T> =>
  googleJson("calendar", "POST", url, accessToken, payload).then((raw) => schema.parse(raw));

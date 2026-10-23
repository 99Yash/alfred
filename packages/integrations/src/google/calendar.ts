import { calendarCreateEventSendsInvitations, parseEmailAddress } from "@alfred/contracts";
import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { uncheckedResponse } from "../shared/authed-json";
import { googleJson } from "./http";

/** Calendar v3 client: list, read, create, update, delete, and answer events. */

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

  const parsed = await googleJson("calendar", listEventsResponseSchema, {
    url: url.toString(),
    accessToken: args.accessToken,
    retry,
  });

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

  return googleJson("calendar", eventSchema, {
    method: "POST",
    url: url.toString(),
    accessToken: args.accessToken,
    payload,
  });
}

export interface EventRefArgs {
  accessToken: string;
  calendarId?: string | undefined;
  /** For a recurring event, an instance id names one occurrence. */
  eventId: string;
}

/** `all` emails the guests about the change. Google sends nothing to an event with no guests. */
export type CalendarSendUpdates = "all" | "none";

function eventUrl(args: Omit<EventRefArgs, "accessToken">, sendUpdates?: CalendarSendUpdates) {
  const calendarId = encodeURIComponent(args.calendarId ?? "primary");
  const eventId = encodeURIComponent(args.eventId);
  const url = new URL(`${API_BASE}/calendars/${calendarId}/events/${eventId}`);

  if (sendUpdates) url.searchParams.set("sendUpdates", sendUpdates);

  return url.toString();
}

export async function getEvent(
  args: EventRefArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<CalendarEvent> {
  return googleJson("calendar", eventSchema, {
    url: eventUrl(args),
    accessToken: args.accessToken,
    retry,
  });
}

/**
 * Attendee objects as Google sends them. A write sends each kept object back whole, so
 * fields this module does not model (`optional`, `resource`, `comment`) survive.
 */
const rawAttendeesSchema = z.object({
  attendees: z.array(z.looseObject({ email: z.string().optional() })).optional(),
});

function sameEmail(a: string | undefined, b: string): boolean {
  const left = parseEmailAddress(a);

  return left !== null && left === parseEmailAddress(b);
}

export interface UpdateEventArgs extends EventRefArgs {
  summary?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  /** RFC3339. Set with `end`. */
  start?: string | undefined;
  end?: string | undefined;
  timeZone?: string | undefined;
  addAttendees?: string[] | undefined;
  removeAttendees?: string[] | undefined;
  sendUpdates: CalendarSendUpdates;
}

/**
 * Patches only the set fields. An attendee change reads the current list first and writes
 * the whole list back, because Google replaces `attendees` as one value.
 */
export async function updateEvent(args: UpdateEventArgs): Promise<CalendarEvent> {
  const { accessToken, addAttendees = [], removeAttendees = [] } = args;
  let attendees: z.infer<typeof rawAttendeesSchema>["attendees"];

  if (addAttendees.length > 0 || removeAttendees.length > 0) {
    const current = await googleJson("calendar", rawAttendeesSchema, {
      url: eventUrl(args),
      accessToken,
    });

    const kept = (current.attendees ?? []).filter(
      (attendee) => !removeAttendees.some((email) => sameEmail(attendee.email, email)),
    );

    const added = addAttendees
      .filter((email) => !kept.some((attendee) => sameEmail(attendee.email, email)))
      .map((email) => ({ email }));

    attendees = [...kept, ...added];
  }

  const payload = {
    summary: args.summary,
    description: args.description,
    location: args.location,
    ...(args.start ? { start: { dateTime: args.start, timeZone: args.timeZone } } : {}),
    ...(args.end ? { end: { dateTime: args.end, timeZone: args.timeZone } } : {}),
    ...(attendees ? { attendees } : {}),
  };

  return googleJson("calendar", eventSchema, {
    method: "PATCH",
    url: eventUrl(args, args.sendUpdates),
    accessToken,
    payload,
  });
}

export interface DeleteEventArgs extends EventRefArgs {
  sendUpdates: CalendarSendUpdates;
}

/** Not idempotent at the wire: a second delete gets a 410. */
export async function deleteEvent(args: DeleteEventArgs): Promise<void> {
  await googleJson("calendar", uncheckedResponse, {
    method: "DELETE",
    url: eventUrl(args, args.sendUpdates),
    accessToken: args.accessToken,
  });
}

export type CalendarResponse = "accepted" | "declined" | "tentative";

export interface RespondToEventArgs extends EventRefArgs {
  /** The user's own attendee email on this event. */
  attendeeEmail: string;
  response: CalendarResponse;
  comment?: string | undefined;
}

/**
 * Sets the user's own response. `attendeesOmitted` tells Google that the one-entry list
 * is partial, so the other guests stay as they are.
 */
export async function respondToEvent(args: RespondToEventArgs): Promise<CalendarEvent> {
  const attendee = {
    email: args.attendeeEmail,
    responseStatus: args.response,
    ...(args.comment ? { comment: args.comment } : {}),
  };

  return googleJson("calendar", eventSchema, {
    method: "PATCH",
    url: eventUrl(args, "all"),
    accessToken: args.accessToken,
    payload: { attendees: [attendee], attendeesOmitted: true },
  });
}

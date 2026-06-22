import { calendarCreateEventInput, calendarListEventsInput, toMessage } from "@alfred/contracts";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  createEvent,
  getFreshAccessToken,
  listCredentials,
  listEvents,
  requireScopes,
  type CalendarEvent,
} from "@alfred/integrations/google";
import type { z } from "zod";
import { localDateInTimezone } from "../briefing/preferences";
import { addLocalDays, localTimeInTimezone } from "../timezone";
import { resolveUserTimezone } from "../user-timezone";
import { liveTool, type RegisteredTool } from "./registry";

const MS_PER_DAY = 86_400_000;

type CalendarListEventsInput = z.infer<typeof calendarListEventsInput>;
type CalendarCreateEventInput = z.infer<typeof calendarCreateEventInput>;

interface CalendarListWindow {
  timeMin: Date;
  timeMax: Date;
  timezone: string;
}

interface CalendarCredential {
  id: string;
  accountLabel: string | null;
}

type CompactCalendarEvent = ReturnType<typeof compactEvent>;

function hasCalendarReadScope(scopes: readonly string[]): boolean {
  return scopes.includes(CALENDAR_READONLY_SCOPE) || scopes.includes(CALENDAR_EVENTS_SCOPE);
}

function hasCalendarWriteScope(scopes: readonly string[]): boolean {
  return scopes.includes(CALENDAR_EVENTS_SCOPE);
}

async function calendarReadCredentials(userId: string): Promise<CalendarCredential[]> {
  const creds = await listCredentials(userId, "google");
  return creds
    .filter((c) => c.status === "active" && hasCalendarReadScope(c.scopes))
    .map((c) => ({ id: c.id, accountLabel: c.accountLabel }));
}

async function calendarWriteCredential(userId: string): Promise<CalendarCredential> {
  const creds = await listCredentials(userId, "google");
  const active = creds.find((c) => c.status === "active" && hasCalendarWriteScope(c.scopes));
  if (!active) {
    throw new Error(
      `[calendar.tools] user ${userId} has no active google credential with calendar.events — reconnect Calendar in settings`,
    );
  }
  return { id: active.id, accountLabel: active.accountLabel };
}

export function resolveCalendarListWindow(
  input: CalendarListEventsInput,
  timezone: string,
  now: Date = new Date(),
): CalendarListWindow {
  if (input.timeMin || input.timeMax) {
    if (input.window || input.partOfDay) {
      throw new Error(
        "calendar.list_events accepts either explicit timeMin/timeMax bounds or relative window/partOfDay, not both",
      );
    }
    const timeMin = input.timeMin ? new Date(input.timeMin) : now;
    const timeMax = input.timeMax
      ? new Date(input.timeMax)
      : new Date(timeMin.getTime() + 7 * MS_PER_DAY);
    if (timeMax <= timeMin) {
      throw new Error("calendar.list_events requires timeMax to be after timeMin");
    }
    return { timeMin, timeMax, timezone };
  }

  const today = localDateInTimezone(timezone, now);
  const relativeWindow = input.window ?? "next_7_days";
  if (relativeWindow === "next_7_days") {
    return {
      timeMin: localTimeInTimezone(today, 0, timezone),
      timeMax: localTimeInTimezone(addLocalDays(today, 7), 0, timezone),
      timezone,
    };
  }

  const date = relativeWindow === "tomorrow" ? addLocalDays(today, 1) : today;
  const [startHour, endHour] = partOfDayHours(input.partOfDay ?? "full_day");
  return {
    timeMin: localTimeInTimezone(date, startHour, timezone),
    timeMax:
      endHour === 24
        ? localTimeInTimezone(addLocalDays(date, 1), 0, timezone)
        : localTimeInTimezone(date, endHour, timezone),
    timezone,
  };
}

function partOfDayHours(part: NonNullable<CalendarListEventsInput["partOfDay"]>): [number, number] {
  switch (part) {
    case "morning":
      return [6, 12];
    case "afternoon":
      return [12, 17];
    case "evening":
      return [17, 22];
    case "full_day":
      return [0, 24];
    default:
      return assertNever(part);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled calendar partOfDay: ${String(value)}`);
}

function compactEvent(credential: CalendarCredential, event: CalendarEvent) {
  const attendees = (event.attendees ?? [])
    .map((a) => {
      if (!a.email) return null;
      return {
        email: a.email,
        displayName: a.displayName ?? null,
        self: a.self ?? false,
        responseStatus: a.responseStatus ?? null,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  return {
    id: event.id,
    accountLabel: credential.accountLabel,
    title: event.summary?.trim() || "(no title)",
    start,
    end,
    allDay: Boolean(event.start?.date) && !event.start?.dateTime,
    location: event.location ?? null,
    attendees,
    hangoutLink: event.hangoutLink ?? null,
    htmlLink: event.htmlLink ?? null,
  };
}

function sortEvents(events: CompactCalendarEvent[]): CompactCalendarEvent[] {
  return events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
}

function allReadsFailed(
  events: readonly CompactCalendarEvent[],
  failures: readonly { credentialId: string; message: string }[],
  credentials: readonly CalendarCredential[],
): boolean {
  return events.length === 0 && failures.length === credentials.length;
}

async function executeListEvents(input: CalendarListEventsInput, userId: string) {
  const timezone = await resolveUserTimezone(userId);
  const window = resolveCalendarListWindow(input, timezone);
  const credentials = await calendarReadCredentials(userId);
  if (credentials.length === 0) {
    throw new Error(
      `[calendar.tools] user ${userId} has no active google credential with calendar.readonly or calendar.events — reconnect Calendar in settings`,
    );
  }

  const events: CompactCalendarEvent[] = [];
  const failures: Array<{ credentialId: string; message: string }> = [];
  for (const credential of credentials) {
    try {
      const accessToken = await getFreshAccessToken(credential.id);
      const result = await listEvents({
        accessToken,
        timeMin: window.timeMin.toISOString(),
        timeMax: window.timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: input.maxResults,
      });
      for (const event of result.events) events.push(compactEvent(credential, event));
    } catch (err) {
      failures.push({
        credentialId: credential.id,
        message: toMessage(err),
      });
    }
  }

  if (allReadsFailed(events, failures, credentials)) {
    throw new Error(
      `[calendar.tools] calendar unavailable for every connected account: ${failures.map((f) => f.message).join("; ")}`,
    );
  }

  return {
    timeMin: window.timeMin.toISOString(),
    timeMax: window.timeMax.toISOString(),
    timezone: window.timezone,
    accountsRead: credentials.length - failures.length,
    failures,
    events: sortEvents(events).slice(0, input.maxResults),
  };
}

async function executeCreateEvent(input: CalendarCreateEventInput, userId: string) {
  const timezone = await resolveUserTimezone(userId);
  const credential = await calendarWriteCredential(userId);
  await requireScopes(credential.id, ["calendar"]);
  const accessToken = await getFreshAccessToken(credential.id);
  const created = await createEvent({
    accessToken,
    calendarId: input.calendarId,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone ?? timezone,
    attendees: input.attendees,
  });

  return { event: compactEvent(credential, created) };
}

export const calendarTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "calendar",
    action: "list_events",
    riskTier: "no_risk",
    description:
      "List Google Calendar events. Prefer the relative window fields for today/tomorrow/next-week questions; use explicit RFC3339 bounds only when the user gave exact dates or times.",
    inputSchema: calendarListEventsInput,
    execute: async (input, ctx) => {
      return executeListEvents(input, ctx.userId);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "create_event",
    riskTier: "medium",
    description: "Create a Google Calendar event after the user approves the details.",
    inputSchema: calendarCreateEventInput,
    execute: async (input, ctx) => {
      return executeCreateEvent(input, ctx.userId);
    },
  }),
];

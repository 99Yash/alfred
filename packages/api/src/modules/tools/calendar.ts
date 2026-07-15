import { calendarCreateEventInput, calendarListEventsInput } from "@alfred/contracts";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  createEvent,
  getFreshAccessToken,
  listEvents,
  requireScopes,
  type CalendarEvent,
} from "@alfred/integrations/google";
import type { z } from "zod";
import { AppError, toPublicAppError, type PublicAppError } from "../../lib/app-errors";
import { logger } from "../../lib/logger";
import { localDateInTimezone } from "../briefing/preferences";
import { addLocalDays, localTimeInTimezone } from "../timezone";
import { activeGoogleCredentials, resolveGoogleCredential } from "./google-credentials";
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

/** Read = either scope; write = the events scope. Matched any-of by the resolver. */
const CALENDAR_READ_SCOPES = [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE] as const;
const CALENDAR_WRITE_SCOPES = [CALENDAR_EVENTS_SCOPE] as const;

/**
 * Every active Calendar-readable account — reads fan out across all of them
 * (an event may live in a personal or a work calendar), unlike the
 * single-credential Google tools.
 */
async function calendarReadCredentials(userId: string): Promise<CalendarCredential[]> {
  const creds = await activeGoogleCredentials(userId, CALENDAR_READ_SCOPES);
  return creds.map((c) => ({ id: c.id, accountLabel: c.accountLabel }));
}

async function calendarWriteCredential(userId: string): Promise<CalendarCredential> {
  const cred = await resolveGoogleCredential(userId, {
    scopes: CALENDAR_WRITE_SCOPES,
    noConnection: "calendar_connection_required",
  });
  return { id: cred.id, accountLabel: cred.accountLabel };
}

export function resolveCalendarListWindow(
  input: CalendarListEventsInput,
  timezone: string,
  now: Date = new Date(),
): CalendarListWindow {
  const bounds = parseExplicitBounds(input, timezone, now);

  // Pure explicit-date/time path: bounds given, no relative window. Honor them
  // exactly; an inverted range is the one genuinely unusable shape, so reject.
  if (bounds && !input.window) {
    if (bounds.timeMax <= bounds.timeMin) {
      throw new AppError("calendar_bounds_order");
    }
    return bounds;
  }

  const relative = resolveRelativeWindow(input, timezone, now);

  // Over-specification: the model supplied BOTH explicit bounds and a relative
  // window. The window is normally the reliable intent — the server resolves it
  // in the user's timezone and the model's hand-computed bounds are the
  // redundant, sloppy part (11/11 observed failures were noon-to-noon "today"
  // bounds alongside window:'today', which *overlap* the real day). So window
  // wins by default. BUT if the bounds are a valid range that is entirely
  // DISJOINT from the resolved window, they can't be sloppy same-day bounds —
  // they're a deliberate specific-date ask ("events on Jul 20") the model *also*
  // (wrongly) stamped a window onto. Honoring the window there would silently
  // answer a different day than the one asked for, so prefer the bounds. This
  // keeps the precedence self-correcting instead of resting on the unverifiable
  // assumption that a present window is always the truer signal.
  if (
    bounds &&
    bounds.timeMin < bounds.timeMax &&
    (bounds.timeMax <= relative.timeMin || bounds.timeMin >= relative.timeMax)
  ) {
    return bounds;
  }
  return relative;
}

/**
 * Parse `timeMin`/`timeMax` into a concrete range, or `null` when neither is set
 * or a value is unparseable. Never throws: the caller decides whether an
 * inverted/invalid range is fatal (the pure-bounds path rejects it) or simply
 * ignorable in favor of a relative window (the over-specified path falls back).
 */
function parseExplicitBounds(
  input: CalendarListEventsInput,
  timezone: string,
  now: Date,
): CalendarListWindow | null {
  if (!input.timeMin && !input.timeMax) return null;
  const timeMin = input.timeMin ? new Date(input.timeMin) : now;
  const timeMax = input.timeMax
    ? new Date(input.timeMax)
    : new Date(timeMin.getTime() + 7 * MS_PER_DAY);
  if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) return null;
  return { timeMin, timeMax, timezone };
}

function resolveRelativeWindow(
  input: CalendarListEventsInput,
  timezone: string,
  now: Date,
): CalendarListWindow {
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

async function executeListEvents(input: CalendarListEventsInput, userId: string, timezone: string) {
  const window = resolveCalendarListWindow(input, timezone);
  const credentials = await calendarReadCredentials(userId);
  if (credentials.length === 0) {
    throw new AppError("calendar_read_connection_required");
  }

  const events: CompactCalendarEvent[] = [];
  const failures: Array<{ credentialId: string } & PublicAppError> = [];
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
      const failure = toPublicAppError(err, "calendar_account_read_failed");
      logger.error(
        { err, event: "calendar_account_read_failed", credentialId: credential.id, userId },
        failure.message,
      );
      failures.push({
        credentialId: credential.id,
        ...failure,
      });
    }
  }

  if (allReadsFailed(events, failures, credentials)) {
    throw new AppError("calendar_unavailable");
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

async function executeCreateEvent(
  input: CalendarCreateEventInput,
  userId: string,
  timezone: string,
) {
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
    discovery: {
      aliases: [
        "check calendar",
        "list calendar events",
        "show my schedule",
        "what's on my calendar",
      ],
      tags: ["calendar", "schedule", "time"],
      entities: ["calendar", "event", "meeting", "schedule"],
      verbs: ["list", "check", "show", "find", "read"],
      relatedTools: ["calendar.create_event"],
    },
    inputSchema: calendarListEventsInput,
    execute: async (input, ctx) => {
      return executeListEvents(input, ctx.userId, ctx.timezone);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "create_event",
    riskTier: "medium",
    description: "Create a Google Calendar event after the user approves the details.",
    discovery: {
      aliases: ["create calendar event", "schedule meeting", "add to calendar"],
      tags: ["calendar", "schedule", "time", "write"],
      entities: ["calendar", "event", "meeting"],
      verbs: ["create", "schedule", "add", "book"],
      relatedTools: ["calendar.list_events"],
    },
    inputSchema: calendarCreateEventInput,
    execute: async (input, ctx) => {
      return executeCreateEvent(input, ctx.userId, ctx.timezone);
    },
  }),
];

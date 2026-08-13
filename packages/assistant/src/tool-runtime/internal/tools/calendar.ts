import {
  calendarCreateEventSendsInvitations,
  calendarCreateEventInput,
  calendarListEventsInput,
  restPassthroughInput,
  type IanaTimezone,
  type ToolRiskTier,
} from "@alfred/contracts";
import {
  CALENDAR_EVENTS_SCOPE,
  CALENDAR_READONLY_SCOPE,
  type CalendarEvent,
} from "@alfred/integrations/google";
import type { z } from "zod";
import { AppError, toPublicAppError, type PublicAppError } from "@alfred/contracts/app-errors";
import { logger } from "@alfred/logging";
import { addDays, inZone } from "@alfred/assistant/time";
import { runRestPassthrough } from "./passthrough";
import {
  liveTool,
  type RegisteredTool,
  type ToolExecuteContext,
} from "@alfred/assistant/tool-runtime";

const MS_PER_DAY = 86_400_000;

type CalendarListEventsInput = z.infer<typeof calendarListEventsInput>;
type CalendarCreateEventInput = z.infer<typeof calendarCreateEventInput>;

export function resolveCalendarCreateEventRiskTier(input: CalendarCreateEventInput): ToolRiskTier {
  return calendarCreateEventSendsInvitations(input) ? "high" : "medium";
}

interface CalendarListWindow {
  timeMin: Date;
  timeMax: Date;
  timezone: IanaTimezone;
}

interface CalendarCredential {
  id: string;
  accountLabel: string | null;
}

type CompactCalendarEvent = ReturnType<typeof compactEvent>;

/** Read = either scope; write = the events scope. Matched any-of by the resolver. */
const CALENDAR_READ_SCOPES = [CALENDAR_READONLY_SCOPE, CALENDAR_EVENTS_SCOPE] as const;
const CALENDAR_WRITE_SCOPES = [CALENDAR_EVENTS_SCOPE] as const;

export function resolveCalendarListWindow(
  input: CalendarListEventsInput,
  timezone: IanaTimezone,
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
  timezone: IanaTimezone,
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
  timezone: IanaTimezone,
  now: Date,
): CalendarListWindow {
  const zone = inZone(timezone);
  const today = zone.day(now);
  const relativeWindow = input.window ?? "next_7_days";
  if (relativeWindow === "next_7_days") {
    return {
      timeMin: zone.startOf(today),
      timeMax: zone.startOf(addDays(today, 7)),
      timezone,
    };
  }

  const date = relativeWindow === "tomorrow" ? addDays(today, 1) : today;
  const [startHour, endHour] = partOfDayHours(input.partOfDay ?? "full_day");
  return {
    timeMin: zone.startOf(date, startHour),
    timeMax: endHour === 24 ? zone.startOf(addDays(date, 1)) : zone.startOf(date, endHour),
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

async function executeListEvents(input: CalendarListEventsInput, ctx: ToolExecuteContext) {
  const window = resolveCalendarListWindow(input, ctx.timezone);
  const credentials = await ctx.integrations.google.calendar.readCredentials();
  if (credentials.length === 0) {
    throw new AppError("calendar_read_connection_required");
  }

  const events: CompactCalendarEvent[] = [];
  const failures: Array<{ credentialId: string } & PublicAppError> = [];
  for (const credential of credentials) {
    try {
      const result = await ctx.integrations.google.calendar.listEvents({
        credentialId: credential.id,
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
        {
          err,
          event: "calendar_account_read_failed",
          credentialId: credential.id,
          userId: ctx.userId,
        },
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

async function executeCreateEvent(input: CalendarCreateEventInput, ctx: ToolExecuteContext) {
  const credential = await ctx.integrations.google.calendar.writeCredential();
  const created = await ctx.integrations.google.calendar.createEvent({
    credentialId: credential.id,
    calendarId: input.calendarId,
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end: input.end,
    timeZone: input.timeZone ?? ctx.timezone,
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
    availability: {
      credential: { provider: "google", anyOfScopes: CALENDAR_READ_SCOPES },
    },
    inputSchema: calendarListEventsInput,
    execute: async (input, ctx) => {
      return executeListEvents(input, ctx);
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
    availability: {
      credential: { provider: "google", anyOfScopes: CALENDAR_WRITE_SCOPES },
    },
    inputSchema: calendarCreateEventInput,
    resolveRiskTier: (input) => Promise.resolve(resolveCalendarCreateEventRiskTier(input)),
    execute: async (input, ctx) => {
      return executeCreateEvent(input, ctx);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "request",
    riskTier: "no_risk",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Google Calendar REST call for anything the curated calendar tools don't cover — the user's calendar list (GET '/users/me/calendarList', '/users/me/calendarList/{id}'), a specific calendar's metadata (GET '/calendars/{id}'), raw event reads on any calendar (GET '/calendars/{id}/events', '/calendars/{id}/events/{eventId}'), or the color palette (GET '/colors'). Prefer the curated calendar.list_events for normal 'what's on my schedule' reads — it resolves the time window in the user's timezone; use this only for structure/metadata the curated tool doesn't return. Pass `method` (GET or HEAD only — writes are rejected at the boundary), a namespace-relative `path` beginning with '/' (include the API version's resource segment, e.g. '/users/me/calendarList'; never a full URL and never the '/calendar/v3' prefix), and `query` for parameters (timeMin, timeMax, singleEvents, maxResults). This is a raw, unvalidated read: a 404 or empty list may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["calendar api", "list calendars", "call calendar", "calendar request"],
      tags: ["calendar", "schedule", "time"],
      entities: ["calendar", "event", "calendar list", "color"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: ["calendar.list_events"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const credential = (await ctx.integrations.google.calendar.readCredentials())[0]!;
      return runRestPassthrough(ctx.integrations.google.calendar.passthrough(credential.id), input);
    },
  }),
];

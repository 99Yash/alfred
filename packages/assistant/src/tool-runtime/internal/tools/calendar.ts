import {
  assertNever,
  calendarCreateEventSendsInvitations,
  calendarCreateEventInput,
  calendarDeleteEventInput,
  calendarListEventsInput,
  calendarRespondToEventInput,
  calendarUpdateEventInput,
  canonicalJson,
  googleAuthorityScopes,
  isHttpError,
  restPassthroughInput,
  type IanaTimezone,
  type ToolRiskTier,
} from "@alfred/contracts";
import { sha256Hex } from "@alfred/db/hash";
import type { CalendarEvent } from "@alfred/integrations/google";
import type { z } from "zod";
import {
  AppError,
  publicAppError,
  toPublicAppError,
  type PublicAppError,
} from "@alfred/contracts/app-errors";
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

type CalendarUpdateEventInput = z.infer<typeof calendarUpdateEventInput>;

type CalendarDeleteEventInput = z.infer<typeof calendarDeleteEventInput>;

type CalendarRespondToEventInput = z.infer<typeof calendarRespondToEventInput>;

/** Google emails every guest about a change, so a change to an event with guests is high. */
async function resolveCalendarUpdateEventRiskTier(
  input: CalendarUpdateEventInput,
  ctx: ToolExecuteContext,
): Promise<ToolRiskTier> {
  if (input.addAttendees || input.removeAttendees) return "high";
  let credentialId: string | undefined;

  try {
    const credential = await eventWriteCredential(input, ctx);
    credentialId = credential.id;

    const event = await ctx.integrations.google.calendar.getEvent({
      credentialId,
      calendarId: input.calendarId,
      eventId: input.eventId,
    });

    return (event.attendees ?? []).some((attendee) => !attendee.self) ? "high" : "medium";
  } catch (err) {
    // An unread event can still have guests, so the tier fails closed.
    logger.warn(
      { err, event: "calendar_update_risk_read_failed", credentialId, userId: ctx.userId },
      "calendar event read failed",
    );

    return "high";
  }
}

interface CalendarListWindow {
  timeMin: Date;
  timeMax: Date;
  timezone: IanaTimezone;
}

interface CalendarCredential {
  id: string;
  accountId: string;
  accountLabel: string | null;
}

type CompactCalendarEvent = ReturnType<typeof compactEvent>;

export function resolveCalendarListWindow(
  input: CalendarListEventsInput,
  timezone: IanaTimezone,
  now: Date = new Date(),
): CalendarListWindow {
  const bounds = parseExplicitBounds(input, timezone, now);

  // Bounds without a window: honor them exactly, but reject an inverted range.
  if (bounds && !input.window) {
    if (bounds.timeMax <= bounds.timeMin) {
      throw new AppError("calendar_bounds_order");
    }

    return bounds;
  }

  const relative = resolveRelativeWindow(input, timezone, now);

  // Both bounds and a window: the window wins, because model-computed bounds are
  // often sloppy (noon-to-noon "today"). Bounds fully disjoint from the window are
  // a deliberate date ask, so they win instead.
  if (
    bounds &&
    bounds.timeMin < bounds.timeMax &&
    (bounds.timeMax <= relative.timeMin || bounds.timeMin >= relative.timeMax)
  ) {
    return bounds;
  }

  return relative;
}

/** Parse `timeMin`/`timeMax`, or `null` when unset or unparseable. Never throws. */
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
      return assertNever(part, "calendar partOfDay");
  }
}

/** The title that list_events shows. A write compares `eventTitle` with it. */
function eventTitle(event: CalendarEvent): string {
  return event.summary?.trim() || "(no title)";
}

/**
 * The fields from `accountId` to `title` are the reference that each write tool takes.
 * `role` tells the model whether the user can change the event or can only answer it.
 */
function compactEvent(credential: CalendarCredential, calendarId: string, event: CalendarEvent) {
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
    accountId: credential.accountId,
    calendarId,
    id: event.id,
    recurringEventId: event.recurringEventId ?? null,
    title: eventTitle(event),
    role: event.organizer?.self ? ("organizer" as const) : ("guest" as const),
    accountLabel: credential.accountLabel,
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
  return events.toSorted((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
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
    throw new AppError("connection_required", { integration: "calendar" });
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

      for (const event of result.events) events.push(compactEvent(credential, "primary", event));
    } catch (err) {
      const failure = toPublicAppError(
        err,
        publicAppError("account_read_failed", { integration: "calendar" }),
      );

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
    throw new AppError("integration_unavailable", { integration: "calendar" });
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

/**
 * The event id for this call. `(runId, toolCallId)` names one call, so a reclaimed run sends the
 * same id and Google refuses the second insert. The input is part of the hash, so an approval
 * with edits makes its own event. SHA-256 hex is valid base32hex.
 */
function createEventId(input: CalendarCreateEventInput, ctx: ToolExecuteContext): string {
  return sha256Hex(canonicalJson({ runId: ctx.runId, toolCallId: ctx.toolCallId, input }));
}

async function executeCreateEvent(input: CalendarCreateEventInput, ctx: ToolExecuteContext) {
  const credential = await ctx.integrations.google.calendar.writeCredential();
  const eventId = createEventId(input, ctx);

  try {
    const created = await ctx.integrations.google.calendar.createEvent({
      credentialId: credential.id,
      calendarId: input.calendarId,
      eventId,
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
      timeZone: input.timeZone ?? ctx.timezone,
      attendees: input.attendees,
    });

    return { event: compactEvent(credential, input.calendarId, created) };
  } catch (err) {
    if (!isHttpError(err) || err.status !== 409) throw err;
  }

  // A 409 means an earlier attempt of this call made the event. Report that event, not a failure.
  const existing = await ctx.integrations.google.calendar.getEvent({
    credentialId: credential.id,
    calendarId: input.calendarId,
    eventId,
  });

  if (existing.status === "cancelled") throw new AppError("calendar_event_cancelled");

  return { event: compactEvent(credential, input.calendarId, existing) };
}

type CalendarEventRef = Pick<CalendarDeleteEventInput, "accountId" | "calendarId" | "eventId">;

/** The account that the reference names, among the accounts that can write events. */
async function eventWriteCredential(
  ref: Pick<CalendarEventRef, "accountId">,
  ctx: ToolExecuteContext,
): Promise<CalendarCredential> {
  const credentials = await ctx.integrations.google.calendar.writeCredentials();
  const credential = credentials.find((candidate) => candidate.accountId === ref.accountId);

  if (!credential) throw new AppError("calendar_account_unknown");

  return credential;
}

/**
 * Reads the event that a write names. A 404 and a 410 become public errors, because the
 * generic "try again" text would make the model repeat a call that cannot pass.
 */
async function readEventForWrite(input: CalendarEventRef, ctx: ToolExecuteContext) {
  const credential = await eventWriteCredential(input, ctx);
  const ref = { credentialId: credential.id, calendarId: input.calendarId, eventId: input.eventId };

  try {
    const event = await ctx.integrations.google.calendar.getEvent(ref);

    return { credential, ref, event, gone: event.status === "cancelled" };
  } catch (err) {
    if (isHttpError(err) && err.status === 410) {
      return { credential, ref, event: null, gone: true };
    }

    if (isHttpError(err) && err.status === 404) {
      throw new AppError("calendar_event_not_found", { cause: err });
    }

    throw err;
  }
}

/** The id and the title must name the same event, so an approval cannot act on another one. */
function assertEventTitle(
  event: CalendarEvent,
  input: Pick<CalendarDeleteEventInput, "eventTitle">,
) {
  if (eventTitle(event) !== input.eventTitle.trim()) {
    throw new AppError("calendar_event_title_mismatch");
  }
}

/** Google refuses a guest's change with a 403, which would reach the model as "try again". */
function assertOrganizer(event: CalendarEvent, guestsMayChange: boolean) {
  if (event.organizer?.self || (guestsMayChange && event.guestsCanModify)) return;

  throw new AppError("calendar_event_not_organizer");
}

/** A 412 means that the event changed after the read that the checks used. */
async function withEtagCheck<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isHttpError(err) && err.status === 412) {
      throw new AppError("calendar_event_changed", { cause: err });
    }

    throw err;
  }
}

async function executeUpdateEvent(input: CalendarUpdateEventInput, ctx: ToolExecuteContext) {
  const { credential, ref, event, gone } = await readEventForWrite(input, ctx);

  if (gone || !event) throw new AppError("calendar_event_cancelled");
  assertEventTitle(event, input);
  assertOrganizer(event, true);

  const updated = await withEtagCheck(() =>
    ctx.integrations.google.calendar.updateEvent({
      ...ref,
      current: event,
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
      timeZone: input.start ? (input.timeZone ?? ctx.timezone) : undefined,
      addAttendees: input.addAttendees,
      removeAttendees: input.removeAttendees,
      sendUpdates: input.notifyGuests ? "all" : "none",
    }),
  );

  return { event: compactEvent(credential, input.calendarId, updated) };
}

async function executeDeleteEvent(input: CalendarDeleteEventInput, ctx: ToolExecuteContext) {
  const { ref, event, gone } = await readEventForWrite(input, ctx);
  const result = { calendarId: input.calendarId, eventId: input.eventId };

  // The event the user asked to remove is already gone, so a retry or a resume succeeds.
  if (gone || !event) return { ok: true, alreadyDeleted: true, ...result };
  assertEventTitle(event, input);
  assertOrganizer(event, false);

  const outcome = await withEtagCheck(() =>
    ctx.integrations.google.calendar.deleteEvent({ ...ref, etag: event.etag, sendUpdates: "all" }),
  );

  return { ok: true, alreadyDeleted: outcome === "already_deleted", ...result };
}

async function executeRespondToEvent(input: CalendarRespondToEventInput, ctx: ToolExecuteContext) {
  const { credential, ref, event, gone } = await readEventForWrite(input, ctx);

  if (gone || !event) throw new AppError("calendar_event_cancelled");
  assertEventTitle(event, input);
  const own = event.attendees?.find((attendee) => attendee.self);

  // An organizer's answer would email every guest about an "update" they did not need.
  if (!own?.email || own.organizer) throw new AppError("calendar_event_not_invited");

  const answered = await ctx.integrations.google.calendar.respondToEvent({
    ...ref,
    attendeeEmail: own.email,
    response: input.response,
    comment: input.comment,
    sendUpdates: "all",
  });

  return { response: input.response, event: compactEvent(credential, input.calendarId, answered) };
}

export const calendarTools: readonly RegisteredTool[] = [
  liveTool({
    integration: "calendar",
    action: "list_events",
    riskTier: "no_risk",
    replay: "safe",
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
      relatedTools: [
        "calendar.create_event",
        "calendar.update_event",
        "calendar.delete_event",
        "calendar.respond_to_event",
      ],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("calendar") },
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
    // The call's event id makes a second insert fail with 409, so a repeat makes no second event.
    replay: "safe",
    description: "Create a Google Calendar event after the user approves the details.",
    discovery: {
      aliases: ["create calendar event", "schedule meeting", "add to calendar"],
      tags: ["calendar", "schedule", "time", "write"],
      entities: ["calendar", "event", "meeting"],
      verbs: ["create", "schedule", "add", "book"],
      relatedTools: ["calendar.list_events", "calendar.update_event", "calendar.delete_event"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("calendar_write") },
    },
    inputSchema: calendarCreateEventInput,
    resolveRiskTier: (input) => Promise.resolve(resolveCalendarCreateEventRiskTier(input)),
    execute: async (input, ctx) => {
      return executeCreateEvent(input, ctx);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "update_event",
    riskTier: "medium",
    replay: "unsafe",
    description:
      "Change a Google Calendar event that the user organizes: title, description, location, " +
      "time, or guests. Pass the event reference from calendar.list_events. Only the fields " +
      "you pass change. To move the event, pass start and end together. For a recurring " +
      "event, the change applies to one occurrence unless you pass the recurringEventId. " +
      "When the user is a guest, use calendar.respond_to_event.",
    discovery: {
      aliases: ["reschedule meeting", "move event", "edit calendar event", "add guest"],
      tags: ["calendar", "schedule", "time", "write"],
      entities: ["calendar", "event", "meeting", "guest"],
      verbs: ["update", "reschedule", "move", "edit", "rename", "invite"],
      relatedTools: ["calendar.list_events", "calendar.delete_event", "calendar.respond_to_event"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("calendar_write") },
    },
    inputSchema: calendarUpdateEventInput,
    resolveRiskTier: (input, ctx) => resolveCalendarUpdateEventRiskTier(input, ctx),
    execute: async (input, ctx) => {
      return executeUpdateEvent(input, ctx);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "delete_event",
    riskTier: "high",
    replay: "safe",
    description:
      "Delete a Google Calendar event that the user organizes, after the user approves it. " +
      "Pass the event reference from calendar.list_events. Google emails the guests that it " +
      "is cancelled. For a recurring event, it deletes one occurrence unless you pass the " +
      "recurringEventId. When the user is a guest, use calendar.respond_to_event with " +
      "declined instead.",
    discovery: {
      aliases: ["cancel meeting", "delete event", "remove from calendar"],
      tags: ["calendar", "schedule", "write"],
      entities: ["calendar", "event", "meeting"],
      verbs: ["delete", "cancel", "remove"],
      relatedTools: ["calendar.list_events", "calendar.update_event", "calendar.respond_to_event"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("calendar_write") },
    },
    inputSchema: calendarDeleteEventInput,
    execute: async (input, ctx) => {
      return executeDeleteEvent(input, ctx);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "respond_to_event",
    // Google emails the answer and the note to the organizer, so it is a real send.
    riskTier: "high",
    replay: "unsafe",
    description:
      "Accept, decline, or tentatively accept a Google Calendar invitation for the user, " +
      "with an optional note, after the user approves it. Pass the event reference from " +
      "calendar.list_events. Google emails the answer to the organizer. For a recurring " +
      "event, it answers one occurrence unless you pass the recurringEventId.",
    discovery: {
      aliases: ["rsvp", "accept invite", "decline meeting", "reply to invitation"],
      tags: ["calendar", "schedule", "write"],
      entities: ["calendar", "event", "meeting", "invitation"],
      verbs: ["accept", "decline", "respond", "rsvp"],
      relatedTools: ["calendar.list_events", "calendar.update_event", "calendar.delete_event"],
    },
    availability: {
      credential: { provider: "google", anyOfScopes: googleAuthorityScopes("calendar_write") },
    },
    inputSchema: calendarRespondToEventInput,
    execute: async (input, ctx) => {
      return executeRespondToEvent(input, ctx);
    },
  }),
  liveTool({
    integration: "calendar",
    action: "request",
    riskTier: "no_risk",
    replay: "safe",
    availability: { passthrough: true },
    description:
      "Issue a raw, READ-ONLY Google Calendar REST call for anything the curated calendar tools don't cover — the user's calendar list (GET '/users/me/calendarList', '/users/me/calendarList/{id}'), a specific calendar's metadata (GET '/calendars/{id}'), raw event reads on any calendar (GET '/calendars/{id}/events', '/calendars/{id}/events/{eventId}'), the color palette (GET '/colors'), or free/busy across calendars (POST '/freeBusy' with a `body` of timeMin, timeMax, and items: [{id}]). Prefer the curated calendar.list_events for normal 'what's on my schedule' reads — it resolves the time window in the user's timezone; use this only for structure/metadata the curated tool doesn't return. Pass `method` (GET or HEAD; POST only for '/freeBusy'; the boundary rejects every other write), a namespace-relative `path` beginning with '/' (include the API version's resource segment, e.g. '/users/me/calendarList'; never a full URL and never the '/calendar/v3' prefix), and `query` for parameters (timeMin, timeMax, singleEvents, maxResults). This is a raw, unvalidated read: a 404 or empty list may mean your path/params were wrong — NOT that the thing is absent. Correct the path once and retry, or state the uncertainty. Never report a raw empty as a confident zero.",
    discovery: {
      aliases: ["calendar api", "list calendars", "call calendar", "calendar request"],
      tags: ["calendar", "schedule", "time"],
      entities: ["calendar", "event", "calendar list", "color"],
      verbs: ["read", "list", "get", "inspect", "query"],
      relatedTools: ["calendar.list_events"],
    },
    inputSchema: restPassthroughInput,
    execute: async (input, ctx) => {
      const [credential] = await ctx.integrations.google.calendar.readCredentials();

      if (!credential) throw new AppError("connection_required", { integration: "calendar" });

      return runRestPassthrough(ctx.integrations.google.calendar.passthrough(credential.id), input);
    },
  }),
];

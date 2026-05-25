import { db } from "@alfred/db";
import { briefingRuns, documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  getFreshAccessToken,
  GOOGLE_FEATURE_SCOPES,
  listEvents,
} from "@alfred/integrations/google";
import { and, desc, eq, isNull, lt, notInArray, or, sql as drizzleSql } from "drizzle-orm";
import { Elysia, status, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { isValidTimezone } from "../briefing/preferences";
import { getPreference } from "../memory/preferences";

/**
 * Per-user read endpoints used by the chat right rail.
 *
 *   GET /api/me/inbox             → recent Gmail threads (Inbox tab)
 *   GET /api/me/briefings/latest  → latest composed briefing run (CTA chip)
 *
 * Both endpoints are best-effort reads: empty arrays / null payloads are
 * normal — the web client renders honest empty states (e.g. "Connect Gmail
 * to see your latest unread threads here").
 */

const INBOX_DEFAULT_LIMIT = 8;
const INBOX_MAX_LIMIT = 50;
/**
 * Triage categories the rail Inbox tab hides. Newsletters + marketing are
 * still ingested (briefing watermark + search), they just don't deserve a
 * slot in the rail-of-twelve. Mirrors `SUPPRESSED_CATEGORIES` in the
 * briefing module without importing it (the briefing list is filtered for
 * compose, not display).
 */
const RAIL_SUPPRESSED_CATEGORIES = ["newsletter", "marketing"];

export interface MeInboxItem {
  documentId: string;
  /**
   * Gmail thread id. Stable across re-ingest and used to deep-link into
   * Gmail web (`https://mail.google.com/mail/u/0/#inbox/<id>`). Null only
   * for documents that lost their thread grouping during ingest — which
   * we don't currently produce for `source = 'gmail'`, but the column is
   * nullable so we keep the type honest.
   */
  threadId: string | null;
  /** Raw `From` header from Gmail metadata, e.g. `"Maya Chen <maya@example.com>"`. */
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  authoredAt: string | null;
  unread: boolean;
  /** Triage category if classified, else null. */
  category: string | null;
}

/**
 * Full payload for a single inbox row — drives the rail's single-email
 * reader pane. Body is the plain-text extraction stored in `documents.content`
 * with the synthetic header block stripped (the header lives in `from`/
 * `to`/`subject`/`authoredAt` already).
 */
export interface MeInboxDetail {
  documentId: string;
  threadId: string | null;
  sender: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
  body: string;
  authoredAt: string | null;
  unread: boolean;
  category: string | null;
}

export interface MeLatestBriefing {
  id: string;
  slot: string;
  briefingDate: string;
  runAt: string;
  subject: string | null;
  status: string;
}

export interface MeMeetingItem {
  /** Google Calendar event id; stable across reads of the same occurrence. */
  id: string;
  title: string;
  /** RFC3339 start; `null` only for ill-formed events we couldn't parse. */
  startAt: string | null;
  /** RFC3339 end; same caveat. */
  endAt: string | null;
  /** All-day if `start.date` was set instead of `start.dateTime`. */
  allDay: boolean;
  location: string | null;
  /** Non-self attendees. */
  attendees: ReadonlyArray<{ email: string; displayName: string | null }>;
  hangoutLink: string | null;
  /** Public web view of the event in Google Calendar. */
  htmlLink: string | null;
}

/**
 * `documents.content` for Gmail is `buildContent(extracted)` output:
 *   `From: …\nTo: …\nSubject: …\nDate: …\n\n<body>`
 * The header block is redundant with `metadata.from` / `.to` / `.subject`
 * and the `authoredAt` column, so strip it before returning to the reader
 * — the UI renders those fields from structured columns instead.
 */
function stripContentHeaders(content: string): string {
  if (!content) return "";
  // The synthetic block ends at the first blank line. If we never wrote a
  // header (some shapes had no parseable fields), `buildContent` returns
  // the body verbatim — recognize that by checking the prefix.
  if (!/^(From|To|Cc|Subject|Date):/m.test(content.slice(0, 200))) {
    return content;
  }
  const blank = content.indexOf("\n\n");
  return blank < 0 ? "" : content.slice(blank + 2);
}

/**
 * Resolve the user's IANA timezone from the general `timezone` preference
 * (shared with workflow scheduling — see `workflows/scheduling.ts`). The
 * briefing module has its own `briefing.timezone` override; the rail isn't
 * briefing-specific, so it reads the general key.
 */
async function resolveUserTimezone(userId: string): Promise<string> {
  const pref = await getPreference(userId, "timezone");
  if (pref && typeof pref.value === "string" && isValidTimezone(pref.value)) {
    return pref.value;
  }
  return "UTC";
}

// Cache Intl.DateTimeFormat by timezone — constructing one allocates dozens of
// objects per locale lookup, and `dayBoundsInTimezone` runs on every request.
const dateFmtByTz = new Map<string, Intl.DateTimeFormat>();
const offsetFmtByTz = new Map<string, Intl.DateTimeFormat>();

function getDateFmt(timezone: string): Intl.DateTimeFormat {
  let fmt = dateFmtByTz.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFmtByTz.set(timezone, fmt);
  }
  return fmt;
}

function getOffsetFmt(timezone: string): Intl.DateTimeFormat {
  let fmt = offsetFmtByTz.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    offsetFmtByTz.set(timezone, fmt);
  }
  return fmt;
}

/**
 * Compute [startOfDay, endOfDay) in `timezone` as UTC `Date` instants.
 * Each bound uses *its own* tz offset (today's for start, tomorrow's for
 * end), so DST transition days correctly produce 23h or 25h windows.
 */
function dayBoundsInTimezone(now: Date, timezone: string): { start: Date; end: Date } {
  const dateFmt = getDateFmt(timezone);
  const offsetFmt = getOffsetFmt(timezone);
  const offsetFor = (d: Date): string => {
    // `longOffset` returns "GMT-05:00" / "GMT" — strip the prefix and
    // default a bare "GMT" to "+00:00" so the ISO string parses uniformly.
    const part = offsetFmt
      .formatToParts(d)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    const off = part.replace(/^GMT/, "");
    return off || "+00:00";
  };
  const tomorrowMs = now.getTime() + 24 * 60 * 60 * 1000;
  const today = dateFmt.format(now);
  const tomorrow = dateFmt.format(new Date(tomorrowMs));
  const start = new Date(`${today}T00:00:00${offsetFor(now)}`);
  const end = new Date(`${tomorrow}T00:00:00${offsetFor(new Date(tomorrowMs))}`);
  return { start, end };
}

export const meRoutes = new Elysia({ prefix: "/api/me" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get(
        "/inbox",
        async ({ user: u, query }) => {
          const limit = Math.min(
            INBOX_MAX_LIMIT,
            Math.max(1, query.limit ?? INBOX_DEFAULT_LIMIT),
          );
          const cursorDate = query.cursor ? new Date(query.cursor) : null;
          if (cursorDate && Number.isNaN(cursorDate.getTime())) {
            return status(400, { message: "Invalid cursor" });
          }

          const baseWhere = and(
            eq(documents.userId, u.id),
            eq(documents.source, "gmail"),
            // Untriaged rows (left join null) and rows that aren't in the
            // suppressed list both belong in the rail.
            or(
              isNull(emailTriage.category),
              notInArray(emailTriage.category, RAIL_SUPPRESSED_CATEGORIES),
            ),
          );

          // Total count drives the "X/N" indicator in the rail. With cursor
          // pagination we don't get this for free, so it's a second roundtrip —
          // cheap at single-user scale, but it's the reason we cap MAX_LIMIT.
          const totalRow = await db()
            .select({ value: drizzleSql<number>`count(*)::int` })
            .from(documents)
            .leftJoin(
              emailTriage,
              and(
                eq(emailTriage.userId, documents.userId),
                eq(emailTriage.sourceThreadId, documents.sourceThreadId),
              ),
            )
            .where(baseWhere);
          const total = totalRow[0]?.value ?? 0;

          const rows = await db()
            .select({
              documentId: documents.id,
              threadId: documents.sourceThreadId,
              subject: documents.title,
              authoredAt: documents.authoredAt,
              metadata: documents.metadata,
              category: emailTriage.category,
            })
            .from(documents)
            .leftJoin(
              emailTriage,
              and(
                eq(emailTriage.userId, documents.userId),
                eq(emailTriage.sourceThreadId, documents.sourceThreadId),
              ),
            )
            .where(
              cursorDate
                ? and(baseWhere, lt(documents.authoredAt, cursorDate))
                : baseWhere,
            )
            .orderBy(desc(documents.authoredAt))
            // Over-fetch by one so we can tell if there's a next page without
            // a second query — drop the extra row before returning.
            .limit(limit + 1);

          const hasMore = rows.length > limit;
          const pageRows = hasMore ? rows.slice(0, limit) : rows;

          const items: MeInboxItem[] = pageRows.map((r) => {
            const meta = (r.metadata as Record<string, unknown> | null) ?? {};
            const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as string[]) : [];
            return {
              documentId: r.documentId,
              threadId: r.threadId ?? null,
              sender: typeof meta.from === "string" ? meta.from : null,
              subject: r.subject ?? null,
              snippet: typeof meta.snippet === "string" ? meta.snippet : null,
              authoredAt: r.authoredAt?.toISOString() ?? null,
              unread: labelIds.includes("UNREAD"),
              category: r.category ?? null,
            };
          });

          const last = pageRows[pageRows.length - 1];
          const nextCursor = hasMore && last?.authoredAt
            ? last.authoredAt.toISOString()
            : null;

          return { items, nextCursor, total };
        },
        {
          query: t.Object({
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: INBOX_MAX_LIMIT })),
            cursor: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/inbox/:documentId",
        async ({ user: u, params }) => {
          const rows = await db()
            .select({
              documentId: documents.id,
              threadId: documents.sourceThreadId,
              subject: documents.title,
              content: documents.content,
              authoredAt: documents.authoredAt,
              metadata: documents.metadata,
              category: emailTriage.category,
            })
            .from(documents)
            .leftJoin(
              emailTriage,
              and(
                eq(emailTriage.userId, documents.userId),
                eq(emailTriage.sourceThreadId, documents.sourceThreadId),
              ),
            )
            .where(
              and(
                eq(documents.userId, u.id),
                eq(documents.source, "gmail"),
                eq(documents.id, params.documentId),
              ),
            )
            .limit(1);

          const row = rows[0];
          if (!row) return status(404, { message: "Not found" });

          const meta = (row.metadata as Record<string, unknown> | null) ?? {};
          const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as string[]) : [];
          return {
            documentId: row.documentId,
            threadId: row.threadId ?? null,
            sender: typeof meta.from === "string" ? meta.from : null,
            to: typeof meta.to === "string" ? meta.to : null,
            cc: typeof meta.cc === "string" ? meta.cc : null,
            subject: row.subject ?? null,
            snippet: typeof meta.snippet === "string" ? meta.snippet : null,
            body: stripContentHeaders(row.content ?? ""),
            authoredAt: row.authoredAt?.toISOString() ?? null,
            unread: labelIds.includes("UNREAD"),
            category: row.category ?? null,
          };
        },
        { params: t.Object({ documentId: t.String() }) },
      )
      .get(
        "/meetings",
        async ({
          user: u,
        }): Promise<{ items: MeMeetingItem[]; connected: boolean }> => {
          // A user can have multiple active Google credentials (e.g. a
          // Gmail-only personal account and a Calendar-only work account).
          // Filter in SQL to the row(s) actually carrying the calendar
          // scope so we don't accidentally pick a Gmail-only cred and
          // report "not connected".
          const calendarScope = GOOGLE_FEATURE_SCOPES.calendar[0];
          const creds = await db()
            .select({
              id: integrationCredentials.id,
              scopes: integrationCredentials.scopes,
            })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.userId, u.id),
                eq(integrationCredentials.provider, "google"),
                eq(integrationCredentials.status, "active"),
              ),
            );
          const row = creds.find((c) => {
            const granted = (c.scopes as string[] | null) ?? [];
            return granted.includes(calendarScope);
          });
          if (!row) return { items: [], connected: false };

          // "Today" is computed in the user's timezone (general
          // `user_preferences.timezone`, falling back to UTC) — the rail
          // is a personal "today's meetings" surface, so server-local
          // would be wrong for any user not co-located with the host.
          const timezone = await resolveUserTimezone(u.id);
          const { start, end } = dayBoundsInTimezone(new Date(), timezone);

          const accessToken = await getFreshAccessToken(row.id);
          const { events } = await listEvents({
            accessToken,
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 50,
          });

          const items: MeMeetingItem[] = events.map((e) => {
            const startIso = e.start?.dateTime ?? e.start?.date ?? null;
            const endIso = e.end?.dateTime ?? e.end?.date ?? null;
            const attendees: Array<{ email: string; displayName: string | null }> = [];
            for (const a of e.attendees ?? []) {
              if (!a.self && a.email) {
                attendees.push({ email: a.email, displayName: a.displayName ?? null });
              }
            }
            return {
              id: e.id,
              title: e.summary ?? "(no title)",
              startAt: startIso,
              endAt: endIso,
              allDay: Boolean(e.start?.date) && !e.start?.dateTime,
              location: e.location ?? null,
              attendees,
              hangoutLink: e.hangoutLink ?? null,
              htmlLink: e.htmlLink ?? null,
            };
          });
          return { items, connected: true };
        },
      )
      .get(
        "/briefings/latest",
        async ({ user: u }): Promise<{ briefing: MeLatestBriefing | null }> => {
          const rows = await db()
            .select({
              id: briefingRuns.id,
              slot: briefingRuns.slot,
              briefingDate: briefingRuns.briefingDate,
              runAt: briefingRuns.runAt,
              subject: briefingRuns.subject,
              status: briefingRuns.status,
            })
            .from(briefingRuns)
            .where(
              and(eq(briefingRuns.userId, u.id), eq(briefingRuns.status, "composed")),
            )
            .orderBy(desc(briefingRuns.runAt))
            .limit(1);
          const row = rows[0];
          return {
            briefing: row
              ? {
                  id: row.id,
                  slot: row.slot,
                  briefingDate: row.briefingDate,
                  runAt: row.runAt.toISOString(),
                  subject: row.subject,
                  status: row.status,
                }
              : null,
          };
        },
      ),
  );

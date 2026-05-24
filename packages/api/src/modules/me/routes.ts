import { db } from "@alfred/db";
import { briefingRuns, documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  getFreshAccessToken,
  GOOGLE_FEATURE_SCOPES,
  listEvents,
} from "@alfred/integrations/google";
import { and, desc, eq, isNull, notInArray, or } from "drizzle-orm";
import { Elysia } from "elysia";
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

const INBOX_LIMIT = 12;
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
  /** Raw `From` header from Gmail metadata, e.g. `"Maya Chen <maya@example.com>"`. */
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  authoredAt: string | null;
  unread: boolean;
  /** Triage category if classified, else null. */
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

/**
 * Compute [startOfDay, endOfDay) in `timezone` as UTC `Date` instants.
 * Each bound uses *its own* tz offset (today's for start, tomorrow's for
 * end), so DST transition days correctly produce 23h or 25h windows.
 */
function dayBoundsInTimezone(now: Date, timezone: string): { start: Date; end: Date } {
  const dateFmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const offsetFor = (d: Date): string => {
    // `longOffset` returns "GMT-05:00" / "GMT" — strip the prefix and
    // default a bare "GMT" to "+00:00" so the ISO string parses uniformly.
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    })
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
      .get("/inbox", async ({ user: u }): Promise<{ items: MeInboxItem[] }> => {
        const rows = await db()
          .select({
            documentId: documents.id,
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
            and(
              eq(documents.userId, u.id),
              eq(documents.source, "gmail"),
              // Untriaged rows (left join null) and rows that aren't in the
              // suppressed list both belong in the rail.
              or(
                isNull(emailTriage.category),
                notInArray(emailTriage.category, RAIL_SUPPRESSED_CATEGORIES),
              ),
            ),
          )
          .orderBy(desc(documents.authoredAt))
          .limit(INBOX_LIMIT);

        const items: MeInboxItem[] = rows.map((r) => {
          const meta = (r.metadata as Record<string, unknown> | null) ?? {};
          const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as string[]) : [];
          return {
            documentId: r.documentId,
            sender: typeof meta.from === "string" ? meta.from : null,
            subject: r.subject ?? null,
            snippet: typeof meta.snippet === "string" ? meta.snippet : null,
            authoredAt: r.authoredAt?.toISOString() ?? null,
            unread: labelIds.includes("UNREAD"),
            category: r.category ?? null,
          };
        });

        return { items };
      })
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

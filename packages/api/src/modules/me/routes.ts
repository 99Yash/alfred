import { db } from "@alfred/db";
import { briefingRuns, documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  getFreshAccessToken,
  listEvents,
  MissingScopesError,
  requireScopes,
} from "@alfred/integrations/google";
import { and, desc, eq, isNull, notInArray, or } from "drizzle-orm";
import { Elysia } from "elysia";
import { authMacro } from "../../middleware/auth";

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
          // Find any active Google credential the user has connected. We
          // don't bother selecting a "calendar credential" specifically;
          // the requireScopes() guard below decides whether this row can
          // actually be used for Calendar reads.
          const cred = await db()
            .select({
              id: integrationCredentials.id,
              scopes: integrationCredentials.scopes,
              status: integrationCredentials.status,
            })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.userId, u.id),
                eq(integrationCredentials.provider, "google"),
                eq(integrationCredentials.status, "active"),
              ),
            )
            .limit(1);
          const row = cred[0];
          if (!row) return { items: [], connected: false };

          try {
            await requireScopes(row.id, ["calendar"]);
          } catch (err) {
            if (err instanceof MissingScopesError) {
              return { items: [], connected: false };
            }
            throw err;
          }

          // Today in the server's clock; Calendar API returns event start
          // times in their original timezones, which the client formats.
          const now = new Date();
          const startOfDay = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            0,
            0,
            0,
            0,
          );
          const endOfDay = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() + 1,
            0,
            0,
            0,
            0,
          );

          const accessToken = await getFreshAccessToken(row.id);
          const { events } = await listEvents({
            accessToken,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 50,
          });

          const items: MeMeetingItem[] = events.map((e) => {
            const startIso = e.start?.dateTime ?? e.start?.date ?? null;
            const endIso = e.end?.dateTime ?? e.end?.date ?? null;
            const attendees = (e.attendees ?? [])
              .filter((a) => !a.self && a.email)
              .map((a) => ({
                email: a.email ?? "",
                displayName: a.displayName ?? null,
              }));
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

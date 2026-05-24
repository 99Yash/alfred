import { db } from "@alfred/db";
import { briefingRuns, documents, emailTriage } from "@alfred/db/schemas";
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

import {
  GOOGLE_SCOPE,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  TRIAGE_RAIL_SUPPRESSED_CATEGORIES,
  USAGE_ACTIVITY_DEFAULT_PAGE_SIZE,
  USAGE_ACTIVITY_MAX_PAGE_SIZE,
  encodeInboxCursor,
  Errors,
  extractGmailDocumentBody,
  isUsageRunCategory,
  parseGmailDocumentMetadata,
  parseInboxCursor,
  toStringArray,
  type BriefingSlot,
  type UsageRunCategory,
  type UsageSortDir,
  type UsageSortField,
  toMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings, documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  extractAttachments,
  extractMessageHtml,
  batchModifyMessages,
  getFreshAccessToken,
  listEvents,
  type ExtractedAttachment,
  type GmailMessage,
} from "@alfred/integrations/google";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
  sql as drizzleSql,
} from "drizzle-orm";
import type { ParsedInboxCursor } from "@alfred/contracts";
import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { resolveBriefingPreferences } from "@alfred/assistant/briefings/preferences";
import { enqueueBriefingRun } from "@alfred/assistant/briefings/queue";
import { notSentGmailDocumentWhere } from "@alfred/assistant/triage/sent-mail";
import { resolveTimezone } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import { sanitizeEmailHtml } from "@alfred/assistant/triage/email-html";
import {
  getUsageActivity,
  getUsageBreakdown,
  getUsageSummary,
} from "@alfred/assistant/execution/usage-report";

/** Per-user reads for the chat right rail. Empty results are normal. */

const BRIEFING_RUN_THROTTLE_SECONDS = 60;

let briefingRunThrottleRedis: BoundedRedis | undefined;

function getBriefingRunThrottleRedis(): BoundedRedis {
  // Not "fail-fast": it rejects the first command, and the catch below reads that as "not throttled".
  briefingRunThrottleRedis ??= createRedisConnection("command");

  return briefingRunThrottleRedis;
}

async function claimBriefingRunRetry(args: {
  userId: string;
  briefingDate: string;
  slot: BriefingSlot;
}): Promise<boolean> {
  try {
    const key = `rate:briefings:run:${args.userId}:${args.briefingDate}:${args.slot}`;

    const claimed = await getBriefingRunThrottleRedis().set(
      key,
      "1",
      "EX",
      BRIEFING_RUN_THROTTLE_SECONDS,
      "NX",
    );

    return claimed === "OK";
  } catch (err) {
    console.warn("[me:briefings] run throttle unavailable:", toMessage(err));

    return true;
  }
}

/** Inbox cursor filter. Must match `orderBy(desc(authoredAt), desc(id))` below. */
function inboxCursorWhere(cursor: ParsedInboxCursor | null) {
  if (!cursor) return undefined;

  return or(
    lt(documents.authoredAt, cursor.authoredAt),
    and(eq(documents.authoredAt, cursor.authoredAt), lt(documents.id, cursor.documentId)),
  );
}

export interface MeInboxItem {
  documentId: string;
  /** Gmail thread id, used to deep-link into Gmail web. The column is nullable. */
  threadId: string | null;
  /** Raw `From` header, e.g. `"Maya Chen <maya@example.com>"`. */
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  authoredAt: string | null;
  unread: boolean;
  category: string | null;
}

/**
 * One Gmail thread for the rail reader, oldest message first.
 *
 * @public Eden infers it from `typeof app`, so knip cannot see the use.
 */
export interface MeInboxDetail {
  threadId: string | null;
  subject: string | null;
  category: string | null;
  selectedDocumentId: string;
  messages: ReadonlyArray<MeInboxMessage>;
}

/** @public Nested in {@link MeInboxDetail}; see its note on Eden inference. */
export interface MeInboxMessage {
  documentId: string;
  sender: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
  /** Plain body, ready for markdown. */
  body: string;
  /** Sanitized `text/html` part, or null. The reader shows it in a sandboxed iframe. */
  htmlBody: string | null;
  authoredAt: string | null;
  unread: boolean;
  /** The client cannot download bytes. A click opens Gmail web. */
  attachments: ReadonlyArray<MeInboxAttachment>;
}

/** @public Nested in {@link MeInboxMessage}; see its note on Eden inference. */
export interface MeInboxAttachment {
  partId: string | null;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
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
  id: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  /** Attendees other than the user. */
  attendees: ReadonlyArray<{ email: string; displayName: string | null }>;
  hangoutLink: string | null;
  htmlLink: string | null;
}

/** Raw HTML that some senders put inside a `text/plain` body. */
const HTML_TAG_RE =
  /<(?:!--|\/?(?:a|p|div|span|br|img|picture|source|table|tr|td|th|ul|ol|li|blockquote|h[1-6]|html|body|head|style|script|font|center|pre|code|hr|strong|em|b|i|u|figure|figcaption|small|details|summary)\b)/i;

/**
 * Clean a `text/plain` Gmail body for the reader: drop the header block,
 * strip embedded HTML, collapse blank lines, fence diffs.
 * Read time only; `documents.content` stays as stored.
 */
function normalizeBodyForReader(
  content: string,
  envelope: Parameters<typeof extractGmailDocumentBody>[1],
): string {
  if (!content) return "";
  const stripped = extractGmailDocumentBody(content, envelope);
  let body = stripped.replace(/\r\n/g, "\n");
  body = body.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/<style[\s\S]*?<\/style>/gi, "");
  body = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  if (HTML_TAG_RE.test(body)) {
    body = body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // Drop trailing spaces, then keep at most one blank line.
  body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  body = fenceDiffBlocks(body);

  return body.trim();
}

/**
 * Wrap unfenced diff runs (GitHub review emails) in a ```diff fence.
 * Without it, markdown reads each `-` line as a list item.
 */
function fenceDiffBlocks(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (looksLikeDiffLine(lines[i])) {
      let end = i;

      while (
        end < lines.length &&
        (looksLikeDiffLine(lines[end]) ||
          (lines[end] === "" && end + 1 < lines.length && looksLikeDiffLine(lines[end + 1])))
      ) {
        end++;
      }

      // Don't swallow trailing blanks into the fence.
      while (end > i + 1 && lines[end - 1] === "") end--;
      const slice = lines.slice(i, end);

      if (slice.length >= 2) {
        out.push("```diff");

        for (const l of slice) out.push(stripQuotePrefix(l));
        out.push("```");
        i = end;
        continue;
      }
    }

    out.push(lines[i] ?? "");
    i++;
  }

  return out.join("\n");
}

function stripQuotePrefix(line: string): string {
  return line.replace(/^>\s?/, "");
}

function looksLikeDiffLine(line: string | undefined): boolean {
  if (line == null) return false;
  // GitHub quotes diff lines as `> +    foo(...)`.
  const stripped = stripQuotePrefix(line);

  // Two or more spaces after the marker. A list item `- bullet` has one.
  return (
    /^[-+] {2,}\S/.test(stripped) ||
    /^[-+]\t/.test(stripped) ||
    /^[-+]$/.test(stripped) ||
    /^@@ -?\d/.test(stripped)
  );
}

const USAGE_DEFAULT_WINDOW_DAYS = 30;

/** Resolve the [start, end) usage window. A bad date is a 400, not a NaN full scan. */
function resolveUsageRange(query: { start?: string; end?: string }) {
  const end = query.end ? new Date(query.end) : new Date();

  if (Number.isNaN(end.getTime())) throw Errors.BadRequestError("Invalid `end` timestamp");

  const start = query.start
    ? new Date(query.start)
    : new Date(end.getTime() - USAGE_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  if (Number.isNaN(start.getTime())) throw Errors.BadRequestError("Invalid `start` timestamp");

  if (start.getTime() > end.getTime()) throw Errors.BadRequestError("`start` must be before `end`");

  return { start, end };
}

function parseUsageCategories(raw: string | undefined): UsageRunCategory[] {
  if (!raw) return [];

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is UsageRunCategory => isUsageRunCategory(s));
}

export const meRoutes = new Elysia({ prefix: "/api/me", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .get(
        "/inbox",
        async ({ user: u, query }) => {
          const limit = Math.min(INBOX_MAX_LIMIT, Math.max(1, query.limit ?? INBOX_DEFAULT_LIMIT));
          const parsedCursor = parseInboxCursor(query.cursor);

          if (parsedCursor === "invalid") {
            throw Errors.BadRequestError("Invalid cursor");
          }

          const baseWhere = and(
            eq(documents.userId, u.id),
            eq(documents.source, "gmail"),
            notSentGmailDocumentWhere(),
            // Untriaged rows (null from the left join) stay in the rail.
            or(
              isNull(emailTriage.category),
              notInArray(emailTriage.category, [...TRIAGE_RAIL_SUPPRESSED_CATEGORIES]),
            ),
          );

          // For the "X/N" indicator. Cursor pages do not give a total.
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

          const cursorFilter = inboxCursorWhere(parsedCursor);
          const where = cursorFilter ? and(baseWhere, cursorFilter) : baseWhere;

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
            .where(where)
            .orderBy(desc(documents.authoredAt), desc(documents.id))
            // One extra row tells us if a next page exists.
            .limit(limit + 1);

          const hasMore = rows.length > limit;
          const pageRows = hasMore ? rows.slice(0, limit) : rows;
          // Gmail ingest always sets `authoredAt`. If it were null, paging would stop here.
          const last = pageRows[pageRows.length - 1];

          const nextCursor =
            hasMore && last?.authoredAt
              ? encodeInboxCursor({ authoredAt: last.authoredAt, documentId: last.documentId })
              : null;

          const items: MeInboxItem[] = pageRows.map((r) => {
            const meta = parseGmailDocumentMetadata(r.metadata);
            const labelIds = meta.labelIds ?? [];

            return {
              documentId: r.documentId,
              threadId: r.threadId ?? null,
              sender: meta.from ?? null,
              subject: r.subject ?? null,
              snippet: meta.snippet ?? null,
              authoredAt: r.authoredAt?.toISOString() ?? null,
              unread: labelIds.includes("UNREAD"),
              category: r.category ?? null,
            };
          });

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
          // Takes a `documentId` but returns its whole thread.
          const selectedRows = await db()
            .select({
              documentId: documents.id,
              threadId: documents.sourceThreadId,
              subject: documents.title,
            })
            .from(documents)
            .where(
              and(
                eq(documents.userId, u.id),
                eq(documents.source, "gmail"),
                eq(documents.id, params.documentId),
                notSentGmailDocumentWhere(),
              ),
            )
            .limit(1);

          const selected = selectedRows[0];

          if (!selected) throw Errors.NotFoundError("Not found");

          // A null thread id falls back to the single row.
          const rowSelector = selected.threadId
            ? eq(documents.sourceThreadId, selected.threadId)
            : eq(documents.id, params.documentId);

          const threadRows = await db()
            .select({
              documentId: documents.id,
              threadId: documents.sourceThreadId,
              subject: documents.title,
              content: documents.content,
              authoredAt: documents.authoredAt,
              metadata: documents.metadata,
              raw: documents.raw,
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
            .where(and(eq(documents.userId, u.id), eq(documents.source, "gmail"), rowSelector))
            // Oldest first, like Gmail web.
            .orderBy(asc(documents.authoredAt), asc(documents.id));

          const messages: MeInboxMessage[] = threadRows.map((row) => {
            const meta = parseGmailDocumentMetadata(row.metadata);
            const labelIds = meta.labelIds ?? [];
            // SAFETY: ingest schema-validated `raw` as a GmailMessage.
            const raw = (row.raw ?? null) as GmailMessage | null;
            const attachments: ExtractedAttachment[] = raw ? extractAttachments(raw) : [];
            const rawHtml = raw ? extractMessageHtml(raw) : null;

            return {
              documentId: row.documentId,
              sender: meta.from ?? null,
              to: meta.to ?? null,
              cc: meta.cc ?? null,
              subject: row.subject ?? null,
              snippet: meta.snippet ?? null,
              body: normalizeBodyForReader(row.content ?? "", {
                from: meta.from,
                to: meta.to,
                cc: meta.cc,
                subject: row.subject,
              }),
              htmlBody: sanitizeEmailHtml(rawHtml),
              authoredAt: row.authoredAt?.toISOString() ?? null,
              unread: labelIds.includes("UNREAD"),
              attachments,
            };
          });

          // The selected row can vanish if a delete races the fan-out.
          const selectedRow =
            threadRows.find((r) => r.documentId === params.documentId) ?? threadRows[0];

          // `satisfies`, not an annotation: the `ReadonlyArray` type made Eden infer attachments as `any`.
          const detail = {
            threadId: selected.threadId ?? null,
            subject: selectedRow?.subject ?? selected.subject ?? null,
            category: selectedRow?.category ?? null,
            selectedDocumentId: params.documentId,
            messages,
          } satisfies MeInboxDetail;

          return detail;
        },
        { params: t.Object({ documentId: t.String() }) },
      )
      .post(
        "/inbox/mark-read",
        async ({ user: u, body }) => {
          // Keep only the user's own rows that are still UNREAD.
          const rows = await db()
            .select({
              id: documents.id,
              sourceId: documents.sourceId,
              accountId: documents.accountId,
              metadata: documents.metadata,
            })
            .from(documents)
            .where(
              and(
                eq(documents.userId, u.id),
                eq(documents.source, "gmail"),
                inArray(documents.id, body.documentIds),
              ),
            );

          const unreadRows = rows.filter((r) => {
            const meta = parseGmailDocumentMetadata(r.metadata);
            const labelIds = meta.labelIds ?? [];

            return labelIds.includes("UNREAD");
          });

          if (unreadRows.length === 0) return { marked: 0 };

          // Group by Google account: another account's token fails the whole batch.
          // Older rows have a NULL accountId.
          const byAccount = new Map<string | null, typeof unreadRows>();

          for (const r of unreadRows) {
            const key = r.accountId ?? null;
            const bucket = byAccount.get(key) ?? [];
            bucket.push(r);
            byAccount.set(key, bucket);
          }

          // Removing a label needs `gmail.modify`.
          const modifyScope = GOOGLE_SCOPE.gmail.modify;

          const creds = await db()
            .select({
              id: integrationCredentials.id,
              accountId: integrationCredentials.accountId,
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

          const modifyCreds = creds.filter((c) => {
            const granted = toStringArray(c.scopes);

            return granted.includes(modifyScope);
          });

          if (modifyCreds.length === 0) {
            throw Errors.ConflictError(
              "Gmail modify scope not granted. Reconnect Gmail to enable this action.",
            );
          }

          const credByAccount = new Map(modifyCreds.map((c) => [c.accountId, c]));
          // NULL-accountId rows use the only modify cred, or are skipped if there are several.
          const fallbackCred = modifyCreds.length === 1 ? modifyCreds[0] : null;

          const markedRows: typeof unreadRows = [];

          for (const [accountId, group] of byAccount) {
            const cred = accountId ? credByAccount.get(accountId) : fallbackCred;

            if (!cred) continue;
            const accessToken = await getFreshAccessToken(cred.id);
            await batchModifyMessages({
              accessToken,
              messageIds: group.map((r) => r.sourceId),
              removeLabelIds: ["UNREAD"],
            });
            markedRows.push(...group);
          }

          if (markedRows.length === 0) {
            throw Errors.ConflictError(
              "Gmail modify scope not granted for these messages. Reconnect Gmail to enable this action.",
            );
          }

          // Update stored labels now so the next /inbox read does not wait for a Gmail sync.
          // Only rows that Gmail actually modified.
          await db()
            .update(documents)
            .set({
              metadata: drizzleSql`jsonb_set(
                ${documents.metadata},
                '{labelIds}',
                COALESCE(${documents.metadata}->'labelIds', '[]'::jsonb) - 'UNREAD'
              )`,
            })
            .where(
              and(
                eq(documents.userId, u.id),
                inArray(
                  documents.id,
                  markedRows.map((r) => r.id),
                ),
              ),
            );

          return { marked: markedRows.length };
        },
        {
          body: t.Object({
            // Capped so this cannot become "mark the whole inbox read".
            documentIds: t.Array(t.String({ minLength: 1 }), {
              minItems: 1,
              maxItems: 50,
            }),
          }),
        },
      )
      .get(
        "/meetings",
        async ({ user: u }): Promise<{ items: MeMeetingItem[]; connected: boolean }> => {
          // A user can have several Google accounts. Pick one with a calendar scope.
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
            const granted = toStringArray(c.scopes);

            return (
              granted.includes(GOOGLE_SCOPE.calendar.readonly) ||
              granted.includes(GOOGLE_SCOPE.calendar.events)
            );
          });

          if (!row) return { items: [], connected: false };

          const { start, end } = inZone(await resolveTimezone(u.id)).dayBounds();

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
          // Today only, so the chip never shows a stale day. The newest slot wins.
          const today = inZone(await resolveTimezone(u.id)).day();

          const rows = await db()
            .select({
              id: briefings.id,
              slot: briefings.slot,
              briefingDate: briefings.briefingDate,
              runAt: briefings.createdAt,
              breakingSummary: briefings.breakingSummary,
              fullBriefing: briefings.fullBriefing,
              status: briefings.status,
            })
            .from(briefings)
            .where(and(eq(briefings.userId, u.id), eq(briefings.briefingDate, today)))
            .orderBy(desc(briefings.createdAt))
            .limit(1);

          const row = rows[0];
          const headline = row?.fullBriefing?.headline ?? null;

          return {
            briefing: row
              ? {
                  id: row.id,
                  slot: row.slot,
                  briefingDate: row.briefingDate,
                  runAt: row.runAt.toISOString(),
                  subject: headline ?? row.breakingSummary,
                  status: row.status,
                }
              : null,
          };
        },
      )
      .post("/briefings/run", async ({ user: u }) => {
        // `reason: "manual"` skips morning suppression, so the slot always sends.
        const prefs = await resolveBriefingPreferences(u.id);
        const zone = inZone(prefs.timezone);
        const briefingDate = zone.day();
        const slot: BriefingSlot = zone.hour() >= prefs.eveningHour ? "evening" : "morning";

        // `composed` and `failed` fall through: `beginBriefing` resumes or retries them.
        const existing = await db()
          .select({ id: briefings.id, status: briefings.status })
          .from(briefings)
          .where(
            and(
              eq(briefings.userId, u.id),
              eq(briefings.briefingDate, briefingDate),
              eq(briefings.slot, slot),
            ),
          )
          .limit(1);

        const row = existing[0];

        if (row) {
          if (row.status === "sent" || row.status === "suppressed") {
            return { status: "exists", slot };
          }

          if (
            row.status === "pending" ||
            row.status === "gathering" ||
            row.status === "composing"
          ) {
            return { status: "running", slot };
          }
        }

        const claimed = await claimBriefingRunRetry({ userId: u.id, briefingDate, slot });

        if (!claimed) {
          throw Errors.TooManyRequestsError(
            "Briefing generation is already retrying. Try again in a minute.",
          );
        }

        const { runId } = await enqueueBriefingRun({
          userId: u.id,
          slot,
          briefingDate,
          reason: "manual",
        });

        return { status: "queued", slot, runId };
      })
      .get(
        "/usage/summary",
        async ({ user: u, query }) => {
          const { start, end } = resolveUsageRange(query);

          return getUsageSummary(u.id, start, end);
        },
        {
          query: t.Object({
            start: t.Optional(t.String()),
            end: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/usage/breakdown",
        async ({ user: u, query }) => {
          const { start, end } = resolveUsageRange(query);

          return getUsageBreakdown(u.id, start, end);
        },
        {
          query: t.Object({
            start: t.Optional(t.String()),
            end: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/usage/activity",
        async ({ user: u, query }) => {
          const { start, end } = resolveUsageRange(query);
          const sortField: UsageSortField = query.sortField === "costUsd" ? "costUsd" : "createdAt";
          const sortDir: UsageSortDir = query.sortDir === "asc" ? "asc" : "desc";

          return getUsageActivity(u.id, {
            start,
            end,
            page: query.page ?? 1,
            pageSize: query.pageSize ?? USAGE_ACTIVITY_DEFAULT_PAGE_SIZE,
            categories: parseUsageCategories(query.categories),
            sortField,
            sortDir,
          });
        },
        {
          query: t.Object({
            start: t.Optional(t.String()),
            end: t.Optional(t.String()),
            page: t.Optional(t.Numeric({ minimum: 1 })),
            pageSize: t.Optional(t.Numeric({ minimum: 1, maximum: USAGE_ACTIVITY_MAX_PAGE_SIZE })),
            /** Comma-separated `UsageRunCategory` values. Unknown values are dropped. */
            categories: t.Optional(t.String()),
            sortField: t.Optional(t.String()),
            sortDir: t.Optional(t.String()),
          }),
        },
      ),
  );

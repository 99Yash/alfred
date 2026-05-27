import { db } from "@alfred/db";
import { briefingRuns, documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  extractAttachments,
  extractMessageHtml,
  batchModifyMessages,
  getFreshAccessToken,
  GMAIL_MODIFY_SCOPE,
  CALENDAR_READONLY_SCOPE,
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
import { Elysia, status, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { isValidTimezone } from "../briefing/preferences";
import { getPreference } from "../memory/preferences";
import { sanitizeEmailHtml } from "./email-html";

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
 * Thread-level payload for the rail reader. The route receives a single
 * `documentId` (the row the user clicked), then fans out to every Gmail
 * doc sharing its `sourceThreadId` — the reader renders them as a
 * conversation timeline, with the clicked message highlighted via
 * `selectedDocumentId`.
 *
 * Subject + category lift to the thread root because both are shared
 * across messages (Gmail thread subjects are stable up to "Re:" prefixes,
 * and email_triage is keyed on the thread). Per-message identifiers
 * (sender, body, attachments, html) live on `MeInboxMessage`.
 */
export interface MeInboxDetail {
  threadId: string | null;
  subject: string | null;
  category: string | null;
  selectedDocumentId: string;
  messages: ReadonlyArray<MeInboxMessage>;
}

export interface MeInboxMessage {
  documentId: string;
  sender: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
  /** Markdown-ready plain body — drives the Reader view. */
  body: string;
  /**
   * Sanitized HTML from the message's `text/html` part. Null when the
   * sender shipped a text-only email or the body sanitized down to
   * nothing. The reader renders this in a sandboxed iframe when present.
   */
  htmlBody: string | null;
  authoredAt: string | null;
  unread: boolean;
  /**
   * File attachments parsed from the cached Gmail payload. The reader pane
   * renders these as chips below the body. `attachmentId` is opaque — the
   * client can't download bytes directly; clicking a chip opens Gmail web.
   */
  attachments: ReadonlyArray<MeInboxAttachment>;
}

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
 * Decode an inbox cursor. The shape is `<authoredAtISO>|<documentId>`;
 * a missing `|` means a legacy timestamp-only cursor and we treat it as
 * invalid rather than silently advancing (clients pick up the new shape
 * on the next page, never mid-pagination).
 *
 * Returns `null` for no cursor, `"invalid"` for parse failure, or the
 * decoded pair for a valid cursor.
 */
function parseInboxCursor(
  raw: string | undefined,
): { authoredAt: Date; documentId: string } | null | "invalid" {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep < 0) return "invalid";
  const iso = raw.slice(0, sep);
  const documentId = raw.slice(sep + 1);
  if (!iso || !documentId) return "invalid";
  const authoredAt = new Date(iso);
  if (Number.isNaN(authoredAt.getTime())) return "invalid";
  return { authoredAt, documentId };
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
 * Detects common shapes of raw HTML hiding inside a `text/plain` body —
 * GitHub notifications, mail-list digests, and a handful of newsletters
 * pack a `<picture>`/`<a>` HTML fallback below the markdown copy.
 */
const HTML_TAG_RE =
  /<(?:!--|\/?(?:a|p|div|span|br|img|picture|source|table|tr|td|th|ul|ol|li|blockquote|h[1-6]|html|body|head|style|script|font|center|pre|code|hr|strong|em|b|i|u|figure|figcaption|small|details|summary)\b)/i;

/**
 * Clean a `text/plain` Gmail body for in-rail rendering. The ingest already
 * prefers `text/plain` over stripped HTML, but some senders embed raw HTML
 * inside the `text/plain` part itself (GitHub badges, "view in browser"
 * fallbacks). Without a pass here the reader prints angle-bracket noise.
 *
 *  - Normalize CRLF → LF so `remark-breaks` produces consistent `<br>`s.
 *  - Strip `<!-- … -->` comments (Devin / GitHub track-and-trace blocks).
 *  - Strip `<style>` / `<script>` blocks wholesale.
 *  - Strip remaining HTML tags when the body trips the tag detector.
 *  - Collapse runs of ≥3 blank lines so HTML-stripped output doesn't leave
 *    a half-page of whitespace where the tags used to sit.
 *
 * This is a read-time cleanup; the persisted `documents.content` stays
 * untouched so a future re-ingest with smarter extraction is free to take
 * over without a migration.
 */
function normalizeBodyForReader(content: string): string {
  if (!content) return "";
  const stripped = stripContentHeaders(content);
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
  // Tame whitespace introduced by the strip — keep paragraph breaks (two
  // newlines) but collapse anything denser. `\s*\n` first so trailing
  // spaces on otherwise-blank lines don't survive as visible whitespace.
  body = body.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  body = fenceDiffBlocks(body);
  return body.trim();
}

/**
 * Detects unified-diff style runs in plaintext email bodies — GitHub PR
 * notifications quote review snippets as raw diff (`-      foo` / `+      bar`)
 * with no surrounding code fence, which makes the markdown parser see each
 * `-` line as a list item and each indented continuation as an indented
 * code block. That renders as bullets-with-boxes, not the unified block
 * the sender intended. Wrapping the run in a ```diff fence collapses it
 * back to a single `<pre>` block in the reader.
 *
 * Conservative on the per-line check (multi-space indent after the marker,
 * which separates diff lines from genuine `- bullet` list items where
 * there's a single space). Permissive on the run shape — a run can be
 * all `+`, all `-`, or mixed, since GitHub review comments quote either
 * direction independently. Lines preceded by the email-quote prefix `> `
 * are peeled before pattern-matching so quoted file snippets fold into
 * the same block.
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
          (lines[end] === "" &&
            end + 1 < lines.length &&
            looksLikeDiffLine(lines[end + 1])))
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
  // Peel the `> ` email-quote prefix first — GitHub review notifications
  // routinely lead the diff with `> +    foo(...)` (the `>` marking the
  // snippet as quoted from the source file).
  const stripped = stripQuotePrefix(line);
  // Multi-space indent after marker rules out genuine markdown list items
  // (`- bullet` and `+ bullet` both use a single space). Tab-separated and
  // bare `+`/`-` (diff hunk separators) also qualify, as does `@@ … @@`.
  return (
    /^[-+] {2,}\S/.test(stripped) ||
    /^[-+]\t/.test(stripped) ||
    /^[-+]$/.test(stripped) ||
    /^@@ -?\d/.test(stripped)
  );
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

export const meRoutes = new Elysia({ prefix: "/api/me", normalize: "typebox" })
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
          // Composite cursor `<authoredAtISO>|<documentId>` — the id
          // tie-breaker avoids skipping rows with identical authoredAt
          // values (Gmail batch notifications routinely share an
          // `internalDate` to the millisecond; a plain timestamp cursor
          // with `lt` would leak the tied row off the next page).
          const parsedCursor = parseInboxCursor(query.cursor);
          if (parsedCursor === "invalid") {
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
              parsedCursor
                ? and(
                    baseWhere,
                    or(
                      lt(documents.authoredAt, parsedCursor.authoredAt),
                      and(
                        eq(documents.authoredAt, parsedCursor.authoredAt),
                        lt(documents.id, parsedCursor.documentId),
                      ),
                    ),
                  )
                : baseWhere,
            )
            // `id` tie-breaks rows sharing an `authoredAt` so the cursor
            // WHERE clause stays consistent with the ORDER BY.
            .orderBy(desc(documents.authoredAt), desc(documents.id))
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
          const nextCursor =
            hasMore && last?.authoredAt
              ? `${last.authoredAt.toISOString()}|${last.documentId}`
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
          // First resolve the selected row to its threadId — we accept a
          // `documentId` (so existing rail links keep working) but the
          // response is thread-shaped.
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
              ),
            )
            .limit(1);

          const selected = selectedRows[0];
          if (!selected) return status(404, { message: "Not found" });

          // Fan out to every sibling message in the same thread. Falls
          // back to the single row when the thread id is null (extremely
          // rare for `source = 'gmail'`, but the column is nullable).
          const threadRows = selected.threadId
            ? await db()
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
                .where(
                  and(
                    eq(documents.userId, u.id),
                    eq(documents.source, "gmail"),
                    eq(documents.sourceThreadId, selected.threadId),
                  ),
                )
                // Oldest first so the reader reads top-to-bottom like a
                // chat transcript — matches how Gmail's web UI orders threads.
                .orderBy(asc(documents.authoredAt), asc(documents.id))
            : await db()
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
                .where(
                  and(
                    eq(documents.userId, u.id),
                    eq(documents.source, "gmail"),
                    eq(documents.id, params.documentId),
                  ),
                );

          const messages: MeInboxMessage[] = threadRows.map((row) => {
            const meta = (row.metadata as Record<string, unknown> | null) ?? {};
            const labelIds = Array.isArray(meta.labelIds)
              ? (meta.labelIds as string[])
              : [];
            // `documents.raw` is the verbatim Gmail message we stored at
            // ingest (schema-validated then). Cast back to `GmailMessage`
            // rather than re-running zod per request — the shape is fixed
            // and parsing the MIME tree dominates the cost anyway.
            const raw = (row.raw ?? null) as GmailMessage | null;
            const attachments: ExtractedAttachment[] = raw
              ? extractAttachments(raw)
              : [];
            const rawHtml = raw ? extractMessageHtml(raw) : null;
            return {
              documentId: row.documentId,
              sender: typeof meta.from === "string" ? meta.from : null,
              to: typeof meta.to === "string" ? meta.to : null,
              cc: typeof meta.cc === "string" ? meta.cc : null,
              subject: row.subject ?? null,
              snippet: typeof meta.snippet === "string" ? meta.snippet : null,
              body: normalizeBodyForReader(row.content ?? ""),
              htmlBody: sanitizeEmailHtml(rawHtml),
              authoredAt: row.authoredAt?.toISOString() ?? null,
              unread: labelIds.includes("UNREAD"),
              attachments,
            };
          });

          // Subject + category lift from the selected row (thread subjects
          // mostly stable up to "Re:" prefixes; email_triage is keyed on
          // the thread anyway). Falls back to the first message when the
          // selected row somehow isn't in the result (e.g. fan-out raced
          // with a delete — defensive).
          const selectedRow =
            threadRows.find((r) => r.documentId === params.documentId) ??
            threadRows[0];
          return {
            threadId: selected.threadId ?? null,
            subject: selectedRow?.subject ?? selected.subject ?? null,
            category: selectedRow?.category ?? null,
            selectedDocumentId: params.documentId,
            messages,
          };
        },
        { params: t.Object({ documentId: t.String() }) },
      )
      .post(
        "/inbox/mark-read",
        async ({ user: u, body }) => {
          // Resolve the requested docs to (Gmail message id, owning
          // account, current labelIds) and filter to the user's own
          // currently-UNREAD Gmail rows. Two things this guards
          // against: a client sending ids it doesn't own (the user_id
          // filter), and a client sending ids that are already read
          // (Gmail would no-op, but we'd still bill a round-trip +
          // write a useless metadata update). Cap the list because the
          // rail page only ever shows ~8 rows; refuse anything
          // sketchier so a bad caller can't ask us to slam Gmail with
          // the full inbox.
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
            const meta = (r.metadata as Record<string, unknown> | null) ?? {};
            const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as string[]) : [];
            return labelIds.includes("UNREAD");
          });
          if (unreadRows.length === 0) return { marked: 0 };

          // Group unread rows by the Google account they were ingested
          // under. A user can connect multiple Google accounts
          // (work + personal) and each `integration_credentials` row
          // only holds tokens for its own mailbox — calling
          // batchModifyMessages with the wrong account's token would
          // 404/403 the whole request. `documents.accountId` mirrors
          // `integration_credentials.account_id` for exactly this
          // reason. Older ingested rows may have NULL accountId, so
          // bucket those under a sentinel and pick the lone modify-
          // scoped cred for them if there is one.
          const byAccount = new Map<string | null, typeof unreadRows>();
          for (const r of unreadRows) {
            const key = r.accountId ?? null;
            const bucket = byAccount.get(key) ?? [];
            bucket.push(r);
            byAccount.set(key, bucket);
          }

          // Find Gmail credentials carrying `gmail.modify` — the
          // read-only briefing scope isn't enough to remove a label.
          // Mirrors the calendar-scope filter in `/meetings` so a
          // Calendar-only Google account doesn't get picked up here.
          const modifyScope = GMAIL_MODIFY_SCOPE;
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
            const granted = (c.scopes as string[] | null) ?? [];
            return granted.includes(modifyScope);
          });
          if (modifyCreds.length === 0) {
            return status(409, {
              message: "Gmail modify scope not granted. Reconnect Gmail to enable this action.",
            });
          }
          const credByAccount = new Map(modifyCreds.map((c) => [c.accountId, c]));
          // Fallback for legacy NULL-accountId docs: the unique
          // modify-scoped cred if there's exactly one, otherwise
          // ambiguous and we skip them.
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
            return status(409, {
              message: "Gmail modify scope not granted for these messages. Reconnect Gmail to enable this action.",
            });
          }

          // Strip UNREAD from each row's stored metadata so the next
          // /inbox refetch reports them as read immediately. Without
          // this the rows would re-appear unread until the next Gmail
          // poll / history sync reconciles labels — a confusing UX gap
          // even for the few seconds it takes. Scoped to the rows we
          // actually modified in Gmail above, so a partial multi-
          // account result doesn't silently desync unmodified rows.
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
            // The rail page caps at 8 visible rows today; 50 leaves
            // headroom for future page-size bumps without blessing
            // server-wide "mark all" via this endpoint.
            documentIds: t.Array(t.String({ minLength: 1 }), {
              minItems: 1,
              maxItems: 50,
            }),
          }),
        },
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
          const calendarScope = CALENDAR_READONLY_SCOPE;
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

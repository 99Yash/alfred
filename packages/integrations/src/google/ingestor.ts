import { db } from "@alfred/db";
import { documents, ingestionState, integrationCredentials } from "@alfred/db/schemas";
import { embedDocument } from "@alfred/ingestion";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getFreshAccessToken } from "./credentials";
import {
  extractMessageContent,
  getMessage,
  isHistoryGoneError,
  listHistory,
  listMessages,
  type GmailHistoryEntry,
  type GmailMessage,
} from "./gmail";

/**
 * One-shot ingestion of recent Gmail messages for a credential.
 *
 * m7a deliberately skips chunking and embedding — we just want to prove
 * the OAuth → list → fetch → write loop works end-to-end. m7b lands the
 * chunker + Voyage embedding pipeline that backfills `chunks` from
 * `documents` (no re-fetching from Gmail required).
 */

export interface IngestRecentArgs {
  credentialId: string;
  /** Default: last 30 days. Overridable for smoke tests. */
  query?: string;
  /** Soft cap on the number of messages to ingest in this run. */
  maxMessages?: number;
  /** Page size for `messages.list` calls. Gmail caps at 500. */
  pageSize?: number;
}

export interface IngestRecentResult {
  fetched: number;
  inserted: number;
  skipped: number;
  errors: number;
  /** New chunk rows written across freshly inserted documents. */
  chunksWritten: number;
  /** Inserted documents whose embed step failed (the doc row still landed). */
  embedFailures: number;
  /** Highest `historyId` we observed — m7c uses this to seed delta polling. */
  highWaterHistoryId: string | null;
  /** Document ids that were freshly inserted this run (skipped/conflict rows excluded). */
  insertedDocumentIds: string[];
  /** User who owns the credential — handy for downstream fanout (triage, indexing). */
  userId: string;
}

const DEFAULT_QUERY = "newer_than:30d";

export async function ingestRecentGmail(args: IngestRecentArgs): Promise<IngestRecentResult> {
  const cred = await loadCredentialOrThrow(args.credentialId);
  const accessToken = await getFreshAccessToken(args.credentialId);

  const query = args.query ?? DEFAULT_QUERY;
  const cap = args.maxMessages ?? 500;
  const pageSize = args.pageSize ?? 100;

  const refs: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  while (refs.length < cap) {
    const page = await listMessages({
      accessToken,
      q: query,
      maxResults: Math.min(pageSize, cap - refs.length),
      pageToken,
    });
    refs.push(...page.messages);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let chunksWritten = 0;
  let embedFailures = 0;
  let highWaterHistoryId: string | null = null;
  const insertedDocumentIds: string[] = [];

  for (const ref of refs) {
    try {
      const message = await getMessage({ accessToken, id: ref.id, format: "full" });
      const result = await persistMessage(cred.userId, cred.accountId, message);
      if (result.outcome === "inserted") {
        inserted++;
        insertedDocumentIds.push(result.documentId);
        // Embed inline. Failures don't bubble — the doc row is still
        // useful for SQL search; m7c's poll will retry the embed via
        // findUnembeddedDocumentIds.
        try {
          const embedResult = await embedDocument({ documentId: result.documentId });
          chunksWritten += embedResult.chunksWritten;
        } catch (err) {
          embedFailures++;
          console.warn(
            `[gmail.ingestor] embed failed for doc=${result.documentId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        skipped++;
      }
      if (message.historyId) {
        if (!highWaterHistoryId || compareHistoryIds(message.historyId, highWaterHistoryId) > 0) {
          highWaterHistoryId = message.historyId;
        }
      }
    } catch (err) {
      errors++;
      console.warn(
        `[gmail.ingestor] failed message=${ref.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await upsertIngestionState({
    credentialId: cred.credentialId,
    userId: cred.userId,
    historyId: highWaterHistoryId,
    fullSync: true,
  });

  return {
    fetched: refs.length,
    inserted,
    skipped,
    errors,
    chunksWritten,
    embedFailures,
    highWaterHistoryId,
    insertedDocumentIds,
    userId: cred.userId,
  };
}

interface CredentialContext {
  credentialId: string;
  userId: string;
  accountId: string;
}

async function loadCredentialOrThrow(credentialId: string): Promise<CredentialContext> {
  const { integrationCredentials } = await import("@alfred/db/schemas");
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      provider: integrationCredentials.provider,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.id, credentialId));
  const row = rows[0];
  if (!row) throw new Error(`[gmail.ingestor] credential not found: ${credentialId}`);
  if (row.provider !== "google") {
    throw new Error(`[gmail.ingestor] credential provider must be google, got ${row.provider}`);
  }
  return { credentialId: row.id, userId: row.userId, accountId: row.accountId };
}

interface PersistMessageResult {
  outcome: "inserted" | "skipped";
  documentId: string;
}

async function persistMessage(
  userId: string,
  accountId: string,
  message: GmailMessage,
): Promise<PersistMessageResult> {
  const extracted = extractMessageContent(message);
  const content = buildContent(extracted);
  const contentHash = sha256(content);

  // The unique index on (user_id, source, source_id) makes
  // `onConflictDoNothing` an idempotent re-ingest: a Gmail message
  // we've already seen does not re-write the row.
  const inserted = await db()
    .insert(documents)
    .values({
      userId,
      source: "gmail",
      sourceId: message.id,
      sourceThreadId: message.threadId,
      accountId,
      title: extracted.subject,
      content,
      contentHash,
      raw: message as unknown as object,
      authoredAt: extracted.date ?? internalDateToDate(message.internalDate),
      metadata: {
        from: extracted.from,
        to: extracted.to,
        cc: extracted.cc,
        labelIds: message.labelIds ?? [],
        historyId: message.historyId,
        sizeEstimate: message.sizeEstimate,
        snippet: message.snippet,
      },
    })
    .onConflictDoNothing({
      target: [documents.userId, documents.source, documents.sourceId],
    })
    .returning({ id: documents.id });
  if (inserted[0]) {
    return { outcome: "inserted", documentId: inserted[0].id };
  }
  // Conflict: look up the existing row's id so callers can still
  // address it (handy for re-embedding a doc that exists but lost its
  // chunks). If the row has vanished between the conflict and this
  // select (concurrent delete or data corruption), fail loudly — an
  // empty id silently propagating into downstream embed/search would
  // be far worse to debug.
  const existing = await db()
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        eq(documents.sourceId, message.id),
      ),
    );
  const existingId = existing[0]?.id;
  if (!existingId) {
    throw new Error(
      `[gmail.ingestor] insert hit conflict but no existing document found for ` +
        `user=${userId} sourceId=${message.id}`,
    );
  }
  return { outcome: "skipped", documentId: existingId };
}

function buildContent(extracted: ReturnType<typeof extractMessageContent>): string {
  const headerLines: string[] = [];
  if (extracted.from) headerLines.push(`From: ${extracted.from}`);
  if (extracted.to) headerLines.push(`To: ${extracted.to}`);
  if (extracted.cc) headerLines.push(`Cc: ${extracted.cc}`);
  if (extracted.subject) headerLines.push(`Subject: ${extracted.subject}`);
  if (extracted.date) headerLines.push(`Date: ${extracted.date.toISOString()}`);
  const header = headerLines.join("\n");
  return header ? `${header}\n\n${extracted.body}` : extracted.body;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function internalDateToDate(internalDate: string | undefined): Date | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** Numeric compare on history-id strings — Gmail's ids are stringified ints. */
function compareHistoryIds(a: string, b: string): number {
  // Coerce via BigInt so we don't trip on JS double precision for very large ids.
  try {
    const ba = BigInt(a);
    const bb = BigInt(b);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

interface UpsertIngestionStateArgs {
  credentialId: string;
  userId: string;
  historyId: string | null;
  fullSync: boolean;
}

async function upsertIngestionState(args: UpsertIngestionStateArgs): Promise<void> {
  const now = new Date();
  await db()
    .insert(ingestionState)
    .values({
      credentialId: args.credentialId,
      userId: args.userId,
      provider: "google",
      stream: "messages",
      state: { historyId: args.historyId },
      lastSyncAt: now,
      lastFullSyncAt: args.fullSync ? now : null,
    })
    .onConflictDoUpdate({
      target: [ingestionState.credentialId, ingestionState.stream],
      set: {
        state: sql`jsonb_set(${ingestionState.state}, '{historyId}', ${JSON.stringify(args.historyId)}::jsonb)`,
        lastSyncAt: now,
        lastFullSyncAt: args.fullSync ? now : ingestionState.lastFullSyncAt,
        updatedAt: now,
      },
    });
}

// ---------------------------------------------------------------------------
// Delta sync via users.history.list
// ---------------------------------------------------------------------------

export interface PollHistoryArgs {
  credentialId: string;
  /**
   * Cap on history pages walked in one call. Each page can yield up to
   * 500 entries; the cap is a defense against runaway loops if a watch
   * channel went silent for days and the history is huge.
   */
  maxPages?: number;
}

export interface PollHistoryResult {
  /** Number of history pages fetched. */
  pagesFetched: number;
  /** New documents written this run. */
  inserted: number;
  /** Messages already on file (no-op insert). */
  skipped: number;
  errors: number;
  chunksWritten: number;
  embedFailures: number;
  /** Cursor advanced to this historyId. */
  cursorBefore: string | null;
  cursorAfter: string | null;
  /**
   * True when the cursor was unusable (404 from Gmail) and we ran a
   * full re-ingest instead. Caller should treat this as "expected
   * occasionally" not a failure.
   */
  fullResync: boolean;
  /** Document ids that were freshly inserted this run. Caller fans triage runs over these. */
  insertedDocumentIds: string[];
  /** User who owns the credential. */
  userId: string;
}

/**
 * Incremental sync from the stored `historyId` cursor. The contract:
 *  - Reads cursor → calls users.history.list until no more pages.
 *  - Fetches + persists each `messagesAdded` message via the same path
 *    as the bulk ingest (so dedupe + embed behave identically).
 *  - Advances the cursor to the latest `historyId` we observed (or the
 *    top-level `historyId` from the response when no entries returned —
 *    this matters during quiet periods so the cursor doesn't go stale).
 *  - On `404 history not found`: cursor is older than Gmail's retention
 *    window; falls back to a full re-ingest so we don't silently miss
 *    a multi-day backlog.
 *
 * The job is idempotent: every persistMessage hits an
 * `onConflictDoNothing` on `(userId, source, sourceId)`, so a webhook
 * + cron poll racing on the same notification is fine.
 */
export async function pollGmailHistory(args: PollHistoryArgs): Promise<PollHistoryResult> {
  const cred = await loadCredentialOrThrow(args.credentialId);
  const accessToken = await getFreshAccessToken(args.credentialId);
  const cursorBefore = await loadHistoryCursor(args.credentialId);

  if (!cursorBefore) {
    // No cursor yet — m7a never ran for this credential, or watch hasn't
    // installed. Fall back to recent ingest; that path also seeds the
    // cursor via `upsertIngestionState`.
    const recent = await ingestRecentGmail({ credentialId: args.credentialId, maxMessages: 200 });
    return {
      pagesFetched: 0,
      inserted: recent.inserted,
      skipped: recent.skipped,
      errors: recent.errors,
      chunksWritten: recent.chunksWritten,
      embedFailures: recent.embedFailures,
      cursorBefore: null,
      cursorAfter: recent.highWaterHistoryId,
      fullResync: true,
      insertedDocumentIds: recent.insertedDocumentIds,
      userId: cred.userId,
    };
  }

  const maxPages = args.maxPages ?? 50;
  let pagesFetched = 0;
  let pageToken: string | undefined;
  const messageIds = new Set<string>();
  let latestHistoryId: string = cursorBefore;

  try {
    while (pagesFetched < maxPages) {
      const page = await listHistory({
        accessToken,
        startHistoryId: cursorBefore,
        pageToken,
      });
      pagesFetched++;

      for (const entry of page.entries) {
        for (const id of collectAddedMessageIds(entry)) messageIds.add(id);
        if (compareHistoryIds(entry.id, latestHistoryId) > 0) latestHistoryId = entry.id;
      }
      // Quiet-period safety: if no entries came back, the response's
      // top-level `historyId` reflects Gmail's current mailbox revision.
      // Adopt it so the next call doesn't re-request the same window.
      if (page.entries.length === 0 && page.historyId) {
        if (compareHistoryIds(page.historyId, latestHistoryId) > 0) {
          latestHistoryId = page.historyId;
        }
      }

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    if (isHistoryGoneError(err)) {
      console.warn(
        `[gmail.ingestor] history cursor stale for ${args.credentialId}; full re-ingest`,
      );
      const recent = await ingestRecentGmail({
        credentialId: args.credentialId,
        maxMessages: 500,
      });
      return {
        pagesFetched,
        inserted: recent.inserted,
        skipped: recent.skipped,
        errors: recent.errors,
        chunksWritten: recent.chunksWritten,
        embedFailures: recent.embedFailures,
        cursorBefore,
        cursorAfter: recent.highWaterHistoryId,
        fullResync: true,
        insertedDocumentIds: recent.insertedDocumentIds,
        userId: cred.userId,
      };
    }
    throw err;
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let chunksWritten = 0;
  let embedFailures = 0;
  const insertedDocumentIds: string[] = [];

  for (const id of messageIds) {
    try {
      const message = await getMessage({ accessToken, id, format: "full" });
      const result = await persistMessage(cred.userId, cred.accountId, message);
      if (result.outcome === "inserted") {
        inserted++;
        insertedDocumentIds.push(result.documentId);
        try {
          const embed = await embedDocument({ documentId: result.documentId });
          chunksWritten += embed.chunksWritten;
        } catch (err) {
          embedFailures++;
          console.warn(
            `[gmail.ingestor] poll embed failed for doc=${result.documentId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.warn(
        `[gmail.ingestor] poll fetch failed for message=${id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await upsertIngestionState({
    credentialId: cred.credentialId,
    userId: cred.userId,
    historyId: latestHistoryId,
    fullSync: false,
  });

  return {
    pagesFetched,
    inserted,
    skipped,
    errors,
    chunksWritten,
    embedFailures,
    cursorBefore,
    cursorAfter: latestHistoryId,
    fullResync: false,
    insertedDocumentIds,
    userId: cred.userId,
  };
}

/** Return added message ids from a history entry. We dedupe upstream via Set. */
function collectAddedMessageIds(entry: GmailHistoryEntry): string[] {
  const out: string[] = [];
  for (const m of entry.messagesAdded ?? []) out.push(m.message.id);
  // `messages` (without -Added/-Deleted) is the union per Gmail docs;
  // include it as a safety net in case we ever drop the historyTypes
  // filter in the call. Duplicates collapse in the Set on the caller.
  for (const m of entry.messages ?? []) out.push(m.id);
  return out;
}

async function loadHistoryCursor(credentialId: string): Promise<string | null> {
  const rows = await db()
    .select({ state: ingestionState.state })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );
  const state = rows[0]?.state as { historyId?: string | null } | undefined;
  const id = state?.historyId;
  return id ?? null;
}

/**
 * Find Gmail credentials whose `last_sync_at` is older than `before`.
 * The 5-minute polling fallback drains this list; webhook-driven polls
 * advance `last_sync_at` so a healthy mailbox never enters the fallback.
 *
 * Note: a credential with no `ingestion_state` row at all is *not*
 * returned — the bulk ingest seeds the row, and a credential without one
 * has nothing to delta-sync from yet.
 */
export async function findCredentialsNeedingPoll(
  before: Date,
): Promise<{ credentialId: string; userId: string }[]> {
  const rows = await db()
    .select({
      credentialId: ingestionState.credentialId,
      userId: ingestionState.userId,
      lastSyncAt: ingestionState.lastSyncAt,
      status: integrationCredentials.status,
    })
    .from(ingestionState)
    .innerJoin(integrationCredentials, eq(integrationCredentials.id, ingestionState.credentialId))
    .where(and(eq(ingestionState.provider, "google"), eq(ingestionState.stream, "messages")));
  return rows
    .filter((r) => r.status === "active")
    .filter((r) => !r.lastSyncAt || r.lastSyncAt < before)
    .map((r) => ({ credentialId: r.credentialId, userId: r.userId }));
}

/** Re-export so callers can find existing credentials before kicking off an ingest. */
export async function listGoogleCredentials(userId: string): Promise<CredentialContext[]> {
  const { integrationCredentials } = await import("@alfred/db/schemas");
  const rows = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      provider: integrationCredentials.provider,
    })
    .from(integrationCredentials)
    .where(
      and(eq(integrationCredentials.userId, userId), eq(integrationCredentials.provider, "google")),
    );
  return rows.map((r) => ({
    credentialId: r.id,
    userId: r.userId,
    accountId: r.accountId,
  }));
}

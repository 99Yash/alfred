import {
  buildGmailDocumentContent,
  gmailDocumentMetadataSchema,
  getPath,
  isSentGmailMetadata,
  mapConcurrent,
  toMessage,
} from "@alfred/contracts";
import { indexDocument, sha256 } from "@alfred/corpus";
import { db } from "@alfred/db";
import { documents, ingestionState, integrationCredentials } from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import {
  extractMessageContent,
  getFreshAccessToken,
  getMessage,
  isHistoryGoneError,
  isSelfAuthored,
  labelSelfAuthoredMail,
  listHistory,
  listMessages,
  type GmailHistoryEntry,
  type GmailMessage,
  type GmailWatchState,
} from "@alfred/integrations/google";
import { installGmailWatch } from "@alfred/integrations/google/internal";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import {
  hasIngestableAttachments,
  ingestGmailMediaAttachments,
  setMediaPending,
  ZERO_MEDIA_TALLY,
  type GmailMediaIngestDeps,
  type GmailMediaIngestResult,
} from "./gmail-media";
import { observeDocumentAskCarrier, type ScheduleDocumentAskObserve } from "../document-asks";

/**
 * Gmail ingestion: writes `documents` and `ingestion_state` and indexes the corpus. The provider
 * package (`@alfred/integrations/google`) keeps only fetch, OAuth, watch and label primitives.
 */

/**
 * Schedules one `gmail.media_ingest` job per message (ADR-0091 amendment). Poll paths never parse
 * attachments inline: that could hold the poll for minutes.
 */
export type ScheduleGmailMediaIngest = (args: {
  credentialId: string;
  messageId: string;
  documentId: string;
}) => Promise<void>;

export interface IngestRecentArgs {
  credentialId: string;
  /** Default: last 30 days. Overridable for smoke tests. */
  query?: string | undefined;
  /** Soft cap on the number of messages to ingest in this run. */
  maxMessages?: number | undefined;
  /** Page size for `messages.list` calls. Gmail caps at 500. */
  pageSize?: number | undefined;
  /**
   * Advance the history cursor. Set false for filtered backfills: a partial query must not claim
   * the whole mailbox was scanned.
   */
  updateCursor?: boolean | undefined;
  /** Set when this ingest covers a detected coverage gap (#560b). */
  coverageGap?: boolean | undefined;
  /** Deferred attachment ingest sink. Production wires `enqueueGmailMediaIngest`. */
  scheduleMediaIngest?: ScheduleGmailMediaIngest | undefined;
}

export interface IngestRecentResult {
  fetched: number;
  inserted: number;
  skipped: number;
  /** Self-authored mail dropped before it became a document (#211). */
  ignored: number;
  errors: number;
  /** New chunk rows written across freshly inserted documents. */
  chunksWritten: number;
  /** Inserted documents whose embed step failed (the doc row still landed). */
  embedFailures: number;
  /** Highest `historyId` seen; seeds delta polling. */
  highWaterHistoryId: string | null;
  /** Freshly inserted document ids. */
  insertedDocumentIds: string[];
  /** Always `[]`: this path embeds every insert inline. */
  unembeddedDocumentIds: string[];
  /** Inserted ids to triage. Sent mail is embedded but never triaged (ADR-0051 #7). */
  triageDocumentIds: string[];
  /** Inserted `SENT` docs. Never triaged, but they re-evaluate the thread tag on a reply (#282). */
  sentDocumentIds: string[];
  /** Threads with a fresh insert, reconciled against live Gmail to drop dead message ids (#279). */
  touchedThreadIds: string[];
  /** Owner of the credential. */
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
  let ignored = 0;
  let errors = 0;
  let chunksWritten = 0;
  let embedFailures = 0;
  let highWaterHistoryId: string | null = null;
  const insertedDocumentIds: string[] = [];
  const triageDocumentIds: string[] = [];
  const sentDocumentIds: string[] = [];
  const touchedThreadIds = new Set<string>();

  for (const ref of refs) {
    try {
      const message = await getMessage({ accessToken, id: ref.id, format: "full" });
      const result = await persistMessage(cred, message, accessToken);

      if (result.outcome === "inserted") {
        inserted++;
        insertedDocumentIds.push(result.documentId);

        if (result.isSent) sentDocumentIds.push(result.documentId);
        else triageDocumentIds.push(result.documentId);

        if (message.threadId) touchedThreadIds.add(message.threadId);

        // Embed failures do not bubble. `gmail.embed_sweep` retries them.
        try {
          const embedResult = await indexDocument({ documentId: result.documentId });
          chunksWritten += embedResult.chunksWritten;
        } catch (err) {
          embedFailures++;
          console.warn(
            `[gmail.ingestor] embed failed for doc=${result.documentId}:`,
            toMessage(err),
          );
        }
      } else if (result.outcome === "ignored") {
        ignored++;
      } else {
        skipped++;
      }

      await scheduleMediaAttachmentsAfterPersist({
        cred,
        message,
        persistResult: result,
        schedule: args.scheduleMediaIngest,
        logId: ref.id,
      });

      if (message.historyId) {
        if (!highWaterHistoryId || compareHistoryIds(message.historyId, highWaterHistoryId) > 0) {
          highWaterHistoryId = message.historyId;
        }
      }
    } catch (err) {
      errors++;
      console.warn(`[gmail.ingestor] failed message=${ref.id}:`, toMessage(err));
    }
  }

  if (args.updateCursor !== false) {
    await upsertIngestionState({
      credentialId: cred.credentialId,
      userId: cred.userId,
      historyId: highWaterHistoryId,
      fullSync: true,
      ...(args.coverageGap ? { coverageGap: true } : {}),
    });
  }

  return {
    fetched: refs.length,
    inserted,
    skipped,
    ignored,
    errors,
    chunksWritten,
    embedFailures,
    highWaterHistoryId,
    insertedDocumentIds,
    unembeddedDocumentIds: [],
    triageDocumentIds,
    sentDocumentIds,
    touchedThreadIds: Array.from(touchedThreadIds),
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

type PersistMessageResult =
  | {
      outcome: "inserted" | "skipped";
      documentId: string;
      /**
       * Mail the user sent. Embedded for recall, but kept out of triage and sender priors (ADR-0051
       * #7).
       */
      isSent: boolean;
    }
  // Self-authored mail, dropped before it becomes a document (#211). Callers treat it like
  // `skipped`.
  | { outcome: "ignored" };

/** Gmail `internalDate` (epoch ms as a string) to a Date, or null. */
function internalDateToDate(internalDate: string | undefined): Date | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);

  if (!Number.isFinite(ms)) return null;

  return new Date(ms);
}

async function persistMessage(
  cred: CredentialContext,
  message: GmailMessage,
  accessToken: string,
): Promise<PersistMessageResult> {
  const { userId, accountId } = cred;
  const extracted = extractMessageContent(message);

  // Drop Alfred's own outbound mail (#211), but label it so it stays findable in Gmail (#285).
  if (isSelfAuthored(extracted.from)) {
    // Best-effort: a label failure must never block the drop.
    if (gmailMailboxWritesEnabled()) {
      try {
        await labelSelfAuthoredMail({
          credentialId: cred.credentialId,
          messageId: message.id,
          accessToken,
          currentLabelIds: message.labelIds ?? undefined,
        });
      } catch (err) {
        console.warn(
          `[gmail.ingestor] failed to label self-authored message=${message.id}:`,
          toMessage(err),
        );
      }
    }

    return { outcome: "ignored" };
  }

  const content = buildGmailDocumentContent({
    from: extracted.from,
    to: extracted.to,
    cc: extracted.cc,
    subject: extracted.subject,
    date: extracted.date,
    body: extracted.body,
  });

  const contentHash = sha256(content);
  const labelIds = message.labelIds ?? [];
  const isSent = labelIds.includes("SENT");

  // Idempotent re-ingest: first-seen wins, so a later subject or body change is not applied.
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
      raw: message,
      authoredAt: extracted.date ?? internalDateToDate(message.internalDate),
      metadata: gmailDocumentMetadataSchema.parse({
        from: extracted.from,
        to: extracted.to,
        cc: extracted.cc,
        labelIds,
        isSent,
        internalDate: message.internalDate,
        historyId: message.historyId,
        sizeEstimate: message.sizeEstimate,
        snippet: message.snippet,
      }),
    })
    .onConflictDoNothing({
      target: [documents.userId, documents.source, documents.sourceId],
    })
    .returning({ id: documents.id });

  if (inserted[0]) {
    return { outcome: "inserted", documentId: inserted[0].id, isSent };
  }

  // Return the existing id so callers can still address the doc. Fail loudly if it vanished.
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

  return { outcome: "skipped", documentId: existingId, isSent };
}

/** Schedule attachment ingest after persist. Skips ignored and attachment-free messages. */
async function scheduleMediaAttachmentsAfterPersist(args: {
  cred: CredentialContext;
  message: GmailMessage;
  persistResult: PersistMessageResult;
  schedule?: ScheduleGmailMediaIngest | undefined;
  logId: string;
}): Promise<void> {
  if (args.persistResult.outcome !== "inserted") return;

  if (!hasIngestableAttachments(args.message)) return;
  await scheduleGmailMediaIngestBestEffort({
    credentialId: args.cred.credentialId,
    messageId: args.message.id,
    documentId: args.persistResult.documentId,
    schedule: args.schedule,
    logId: args.logId,
  });
}

/**
 * Set `mediaPending` first, then enqueue. The flag stays until a clean `gmail.media_ingest` run, so
 * the next poll re-schedules a lost or failed job.
 */
async function scheduleGmailMediaIngestBestEffort(args: {
  credentialId: string;
  messageId: string;
  documentId: string;
  schedule: ScheduleGmailMediaIngest | undefined;
  logId: string;
}): Promise<void> {
  if (!args.schedule) {
    console.warn(
      `[gmail.ingestor] no media scheduler wired; attachment ingest deferred for message=${args.logId}`,
    );

    return;
  }

  try {
    await setMediaPending(args.documentId, true);
    await args.schedule({
      credentialId: args.credentialId,
      messageId: args.messageId,
      documentId: args.documentId,
    });
  } catch (err) {
    console.warn(
      `[gmail.ingestor] attachment schedule failed for message=${args.logId}:`,
      toMessage(err),
    );
  }
}

/**
 * Run a `gmail.media_ingest` job. Fetches the message fresh and re-checks self-authorship. Clears
 * `mediaPending` on a clean pass and keeps it on any error. Embed failures are left to
 * `gmail.embed_sweep`.
 */
export async function runGmailMediaIngest(args: {
  credentialId: string;
  messageId: string;
  documentId: string;
  /** Re-observes a carrier whose ask a sibling's live media blocks. */
  scheduleObserve: ScheduleDocumentAskObserve;
  /** Test seam. */
  deps?: RunGmailMediaIngestDeps | undefined;
}): Promise<GmailMediaIngestResult> {
  const getFreshAccessTokenFn = args.deps?.getFreshAccessToken ?? getFreshAccessToken;
  const getMessageFn = args.deps?.getMessage ?? getMessage;
  const cred = await loadCredentialOrThrow(args.credentialId);
  const accessToken = await getFreshAccessTokenFn(args.credentialId);
  const message = await getMessageFn({ accessToken, id: args.messageId, format: "full" });
  const extracted = extractMessageContent(message);

  if (isSelfAuthored(extracted.from)) return { ...ZERO_MEDIA_TALLY, documentIds: [] };

  const result = await ingestGmailMediaAttachments({
    userId: cred.userId,
    accountId: cred.accountId,
    message,
    accessToken,
    authoredAt: internalDateToDate(message.internalDate),
    ...(args.deps?.media ? { deps: args.deps.media } : {}),
  });

  // Clear the flag before observing, so a sibling media job can make the final observation.
  await setMediaPending(args.documentId, result.errors > 0);

  try {
    // The reducer reads everything it needs from the persisted rows.
    await observeDocumentAskCarrier(
      {
        userId: cred.userId,
        carrier: { accountId: cred.accountId, messageId: message.id },
        observedAt: new Date(),
      },
      args.scheduleObserve,
    );
  } catch (err) {
    // Keep the job retryable: the flag was already cleared above. A retried schedule is deduped.
    await setMediaPending(args.documentId, true);
    throw err;
  }

  if (result.errors > 0 || result.embedFailures > 0) {
    console.warn(
      `[gmail.media] job mediaErrors=${result.errors} mediaEmbedFailures=${result.embedFailures} ` +
        `for message=${args.messageId}`,
    );
  }

  return result;
}

export interface RunGmailMediaIngestDeps {
  getFreshAccessToken?: typeof getFreshAccessToken | undefined;
  getMessage?: typeof getMessage | undefined;
  media?: GmailMediaIngestDeps | undefined;
}

/** Compare Gmail history ids, which are integer strings. */
function compareHistoryIds(a: string, b: string): number {
  // BigInt, because large ids lose precision as doubles.
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
  /** Coverage gap detected: history gone or cursor jump (#560b). */
  coverageGap?: boolean;
  /**
   * Start of a fallback poll that inserted an unannounced message. Completion latency must not move
   * it.
   */
  fallbackInsertAt?: Date | undefined;
  /** The webhook pass finished with no message errors. */
  webhookSyncCompleted?: boolean | undefined;
}

async function upsertIngestionState(args: UpsertIngestionStateArgs): Promise<void> {
  const now = new Date();
  const fallbackInsertAt = args.fallbackInsertAt ?? null;
  const newId = args.historyId; // string | null — drizzle binds null as SQL NULL
  // `coverageGap` clears when the cursor advances.
  const coverageGapValue = args.coverageGap ?? false;
  await db()
    .insert(ingestionState)
    .values({
      credentialId: args.credentialId,
      userId: args.userId,
      provider: "google",
      stream: "messages",
      state: {
        historyId: args.historyId,
        ...(args.coverageGap ? { coverageGap: true } : {}),
      },
      lastSyncAt: now,
      lastWebhookSyncAt: args.webhookSyncCompleted ? now : null,
      lastFullSyncAt: args.fullSync ? now : null,
      lastFallbackInsertAt: fallbackInsertAt,
    })
    .onConflictDoUpdate({
      target: [ingestionState.credentialId, ingestionState.stream],
      set: {
        // Compare-and-advance in SQL (ADR-0037): `pollGmailRecent` and `pollGmailHistory` race, so
        // the cursor only moves to a strictly higher id and never rolls back. `lastSyncAt` still
        // updates, so the credential reads as fresh.
        state: sql`
          jsonb_set(
            CASE
              WHEN ${coverageGapValue}::boolean = true
                THEN jsonb_set(
                  CASE
                    WHEN ${newId}::text IS NOT NULL
                      AND (${ingestionState.state}->>'historyId') IS NOT NULL
                      AND ${newId}::bigint > (${ingestionState.state}->>'historyId')::bigint
                      THEN jsonb_set(${ingestionState.state}, '{coverageGap}', 'false')
                    ELSE ${ingestionState.state}
                  END,
                  '{coverageGap}', 'true'
                )
              WHEN ${newId}::text IS NOT NULL
                AND (${ingestionState.state}->>'historyId') IS NOT NULL
                AND ${newId}::bigint > (${ingestionState.state}->>'historyId')::bigint
                THEN jsonb_set(${ingestionState.state}, '{coverageGap}', 'false')
              ELSE ${ingestionState.state}
            END,
            '{historyId}',
            CASE
              WHEN ${newId}::text IS NULL
                THEN ${ingestionState.state}->'historyId'
              WHEN (${ingestionState.state}->>'historyId') IS NULL
                THEN to_jsonb(${newId}::text)
              WHEN ${newId}::bigint > (${ingestionState.state}->>'historyId')::bigint
                THEN to_jsonb(${newId}::text)
              ELSE ${ingestionState.state}->'historyId'
            END
          )
        `,
        lastSyncAt: now,
        lastWebhookSyncAt: args.webhookSyncCompleted ? now : ingestionState.lastWebhookSyncAt,
        lastFullSyncAt: args.fullSync ? now : ingestionState.lastFullSyncAt,
        lastFallbackInsertAt: fallbackInsertAt
          ? sql`greatest(${ingestionState.lastFallbackInsertAt}, ${fallbackInsertAt}::timestamptz)`
          : ingestionState.lastFallbackInsertAt,
        updatedAt: now,
      },
    });
}

/**
 * Seed the history cursor when no row exists. A watch renewal must not reset an existing cursor, or
 * mail between the last poll and now is skipped.
 */
export async function seedGmailHistoryCursorIfAbsent(args: {
  credentialId: string;
  historyId: string;
}): Promise<void> {
  const existing = await db()
    .select({ id: ingestionState.id })
    .from(ingestionState)
    .where(
      and(
        eq(ingestionState.credentialId, args.credentialId),
        eq(ingestionState.stream, "messages"),
      ),
    );

  if (existing[0]) return;

  // Seed a cursor. The FK needs userId from the credential.
  const credRow = (
    await db()
      .select({ userId: integrationCredentials.userId })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, args.credentialId))
  )[0];

  if (!credRow) {
    throw new Error(`[gmail.ingest] credential vanished mid-install: ${args.credentialId}`);
  }

  await db()
    .insert(ingestionState)
    .values({
      credentialId: args.credentialId,
      userId: credRow.userId,
      provider: "google",
      stream: "messages",
      state: { historyId: args.historyId },
      lastSyncAt: null,
      lastFullSyncAt: null,
    })
    .onConflictDoNothing({
      target: [ingestionState.credentialId, ingestionState.stream],
    });
}

/**
 * Install or renew a Gmail watch, then seed the cursor. Every install site must use this: without a
 * cursor, `pollGmailHistory` falls into a full re-sync every time. `null` state means mailbox
 * writes are disabled (#278) and no watch exists.
 */
export async function installGmailWatchAndSeedCursor(args: {
  credentialId: string;
  topicName: string;
  labelIds?: string[] | undefined;
}): Promise<GmailWatchState | null> {
  const state = await installGmailWatch(args);

  if (state) {
    await seedGmailHistoryCursorIfAbsent({
      credentialId: args.credentialId,
      historyId: state.baselineHistoryId,
    });
  }

  return state;
}

// ---------------------------------------------------------------------------
// Delta sync via users.history.list
// ---------------------------------------------------------------------------

/**
 * Why a `gmail.poll_history` job ran. Gmail pushes every mailbox change, so a message that only the
 * `poll-fallback` sweep found is a missed push (#998).
 */
export type GmailPollHistoryReason = "webhook" | "poll-fallback";

export interface PollHistoryArgs {
  credentialId: string;
  /** `undefined` for a direct call. */
  reason?: GmailPollHistoryReason | undefined;
  /** Page cap, against a runaway walk after a long-silent watch. */
  maxPages?: number | undefined;
  /** Deferred attachment ingest sink. Production wires `enqueueGmailMediaIngest`. */
  scheduleMediaIngest?: ScheduleGmailMediaIngest | undefined;
}

export interface PollHistoryResult {
  /** Number of history pages fetched. */
  pagesFetched: number;
  inserted: number;
  /** Messages already on file. */
  skipped: number;
  /** Self-authored mail dropped (#211). */
  ignored: number;
  errors: number;
  chunksWritten: number;
  embedFailures: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  /** The cursor returned 404, so this run did a full re-ingest. Expected now and then. */
  fullResync: boolean;
  insertedDocumentIds: string[];
  /**
   * `[]` on the main path, which embeds inline. The fallbacks forward `ingestRecentGmail`'s value.
   */
  unembeddedDocumentIds: string[];
  /** Non-sent inserts, for triage. */
  triageDocumentIds: string[];
  /** SENT docs that drive reply re-eval (#282), including rows another path inserted first. */
  sentDocumentIds: string[];
  /** Threads to reconcile against live Gmail (#279). */
  touchedThreadIds: string[];
  userId: string;
}

/**
 * Delta sync from the stored `historyId` cursor through `users.history.list`. With no entries,
 * adopt the response's top-level `historyId` so a quiet mailbox does not go stale. A 404 means the
 * cursor is past Gmail's retention, so fall back to a full re-ingest. Idempotent: inserts conflict
 * on `(userId, source, sourceId)`.
 */
export async function pollGmailHistory(args: PollHistoryArgs): Promise<PollHistoryResult> {
  const startedAt = new Date();
  const cred = await loadCredentialOrThrow(args.credentialId);
  const accessToken = await getFreshAccessToken(args.credentialId);
  const cursorBefore = await loadHistoryCursor(args.credentialId);

  if (!cursorBefore) {
    // No cursor yet. Recent ingest also seeds it.
    const recent = await ingestRecentGmail({
      credentialId: args.credentialId,
      maxMessages: 200,
      scheduleMediaIngest: args.scheduleMediaIngest,
    });

    return {
      pagesFetched: 0,
      inserted: recent.inserted,
      skipped: recent.skipped,
      ignored: recent.ignored,
      errors: recent.errors,
      chunksWritten: recent.chunksWritten,
      embedFailures: recent.embedFailures,
      cursorBefore: null,
      cursorAfter: recent.highWaterHistoryId,
      fullResync: true,
      insertedDocumentIds: recent.insertedDocumentIds,
      unembeddedDocumentIds: recent.unembeddedDocumentIds,
      triageDocumentIds: recent.triageDocumentIds,
      sentDocumentIds: recent.sentDocumentIds,
      touchedThreadIds: recent.touchedThreadIds,
      userId: cred.userId,
    };
  }

  const maxPages = args.maxPages ?? 50;
  let pagesFetched = 0;
  let pageToken: string | undefined;
  const messageIds = new Map<string, string>();
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
        for (const id of collectAddedMessageIds(entry)) {
          // Keep the revision of the addition. `messages.get` can return a later one from a label
          // change.
          if (!messageIds.has(id)) messageIds.set(id, entry.id);
        }

        if (compareHistoryIds(entry.id, latestHistoryId) > 0) latestHistoryId = entry.id;
      }

      // Quiet period: adopt the mailbox's current `historyId`.
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
        coverageGap: true,
        scheduleMediaIngest: args.scheduleMediaIngest,
      });

      // The re-sync closed the gap, so clear the flag set above (#560b).
      await upsertIngestionState({
        credentialId: cred.credentialId,
        userId: cred.userId,
        historyId: recent.highWaterHistoryId,
        fullSync: true,
        coverageGap: false,
      });

      return {
        pagesFetched,
        inserted: recent.inserted,
        skipped: recent.skipped,
        ignored: recent.ignored,
        errors: recent.errors,
        chunksWritten: recent.chunksWritten,
        embedFailures: recent.embedFailures,
        cursorBefore,
        cursorAfter: recent.highWaterHistoryId,
        fullResync: true,
        insertedDocumentIds: recent.insertedDocumentIds,
        unembeddedDocumentIds: recent.unembeddedDocumentIds,
        triageDocumentIds: recent.triageDocumentIds,
        sentDocumentIds: recent.sentDocumentIds,
        touchedThreadIds: recent.touchedThreadIds,
        userId: cred.userId,
      };
    }

    throw err;
  }

  let inserted = 0;
  let skipped = 0;
  let ignored = 0;
  let errors = 0;
  let chunksWritten = 0;
  let embedFailures = 0;
  const insertedDocumentIds: string[] = [];
  const triageDocumentIds: string[] = [];
  const sentDocumentIds: string[] = [];
  const touchedThreadIds = new Set<string>();

  let insertedHistoryId: string | null = null;

  for (const [id, addedHistoryId] of messageIds) {
    try {
      const message = await getMessage({ accessToken, id, format: "full" });
      const result = await persistMessage(cred, message, accessToken);

      if (result.outcome === "inserted") {
        inserted++;

        if (!insertedHistoryId || compareHistoryIds(addedHistoryId, insertedHistoryId) > 0) {
          insertedHistoryId = addedHistoryId;
        }

        insertedDocumentIds.push(result.documentId);

        if (result.isSent) sentDocumentIds.push(result.documentId);
        else triageDocumentIds.push(result.documentId);

        if (message.threadId) touchedThreadIds.add(message.threadId);

        try {
          const embed = await indexDocument({ documentId: result.documentId });
          chunksWritten += embed.chunksWritten;
        } catch (err) {
          embedFailures++;
          console.warn(
            `[gmail.ingestor] poll embed failed for doc=${result.documentId}:`,
            toMessage(err),
          );
        }
      } else if (result.outcome === "ignored") {
        ignored++;
      } else {
        skipped++;

        if (result.isSent) {
          sentDocumentIds.push(result.documentId);

          if (message.threadId) touchedThreadIds.add(message.threadId);
        }
      }

      await scheduleMediaAttachmentsAfterPersist({
        cred,
        message,
        persistResult: result,
        schedule: args.scheduleMediaIngest,
        logId: id,
      });
    } catch (err) {
      errors++;
      console.warn(`[gmail.ingestor] poll fetch failed for message=${id}:`, toMessage(err));
    }
  }

  // An old internalDate can hide announced mail from the realtime search, so a late insert proves
  // nothing.
  const pushedHistoryId =
    args.reason === "poll-fallback" && insertedHistoryId
      ? await loadHighestReceiptHistoryId(args.credentialId)
      : null;

  const unannouncedInsert =
    insertedHistoryId !== null &&
    (!pushedHistoryId || compareHistoryIds(insertedHistoryId, pushedHistoryId) > 0);

  // Stamp the poll start, so fetch latency cannot age the evidence (#998). The full re-sync
  // branches above skip this: a backlog says nothing about push liveness.
  await upsertIngestionState({
    credentialId: cred.credentialId,
    userId: cred.userId,
    historyId: latestHistoryId,
    fullSync: false,
    fallbackInsertAt: args.reason === "poll-fallback" && unannouncedInsert ? startedAt : undefined,
  });

  return {
    pagesFetched,
    inserted,
    skipped,
    ignored,
    errors,
    chunksWritten,
    embedFailures,
    cursorBefore,
    cursorAfter: latestHistoryId,
    fullResync: false,
    insertedDocumentIds,
    unembeddedDocumentIds: [],
    triageDocumentIds,
    sentDocumentIds,
    touchedThreadIds: Array.from(touchedThreadIds),
    userId: cred.userId,
  };
}

// ---------------------------------------------------------------------------
// Realtime sync via users.messages.list (ADR-0037)
// ---------------------------------------------------------------------------

export interface PollRecentDeps {
  listMessages?: typeof listMessages | undefined;
  getMessage?: typeof getMessage | undefined;
  getFreshAccessToken?: typeof getFreshAccessToken | undefined;
  /** Deferred attachment ingest sink. Production wires `enqueueGmailMediaIngest`. */
  scheduleMediaIngest?: ScheduleGmailMediaIngest | undefined;
}

export interface PollRecentArgs {
  credentialId: string;
  /** Search window for `newer_than:<window>`. */
  window?: string | undefined;
  /** Soft cap on messages considered. */
  maxMessages?: number | undefined;
  /** Concurrency for the per-message fetch and persist. */
  concurrency?: number | undefined;
  /** Pub/Sub push historyId for gap detection (#560b). */
  pushHistoryId?: string | undefined;
  /** Test seam. */
  deps?: PollRecentDeps | undefined;
}

export interface PollRecentResult {
  /** Messages returned by `messages.list`. */
  listed: number;
  /** Freshly persisted documents. */
  inserted: number;
  /** Messages already on file. */
  skipped: number;
  /** Self-authored mail dropped (#211). */
  ignored: number;
  errors: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  insertedDocumentIds: string[];
  /**
   * The only deferred-embed path: equals `insertedDocumentIds`, so Voyage stays off tag latency
   * (ADR-0037).
   */
  unembeddedDocumentIds: string[];
  /** Non-sent inserts, for triage. */
  triageDocumentIds: string[];
  /** SENT docs that drive reply re-eval (#282), including rows the catch-up path inserted first. */
  sentDocumentIds: string[];
  /** Threads to reconcile against live Gmail (#279). */
  touchedThreadIds: string[];
  userId: string;
}

/**
 * Realtime fetch on a Pub/Sub push (ADR-0037). Uses the search index (`messages.list`), which
 * updates in seconds, not `history.list`, which can lag the push by minutes. Moves the cursor
 * forward only. Does not embed; the caller triages first, then indexes. The `poll-fallback` sweep
 * through `pollGmailHistory` catches what this misses.
 */
export async function pollGmailRecent(args: PollRecentArgs): Promise<PollRecentResult> {
  const listMessagesFn = args.deps?.listMessages ?? listMessages;
  const getMessageFn = args.deps?.getMessage ?? getMessage;
  const getFreshAccessTokenFn = args.deps?.getFreshAccessToken ?? getFreshAccessToken;
  const scheduleMediaIngest = args.deps?.scheduleMediaIngest;

  // Independent reads, so run them together.
  const [cred, accessToken, state] = await Promise.all([
    loadCredentialOrThrow(args.credentialId),
    getFreshAccessTokenFn(args.credentialId),
    loadIngestionState(args.credentialId),
  ]);

  const cursorBefore = state.historyId;

  // Receipts land even when BullMQ dedups the job, so they hold the highest pushed id (#560b).
  const latestReceiptHistoryId = await loadHighestReceiptHistoryId(args.credentialId);

  const windowExpr = args.window ?? "5m";
  const cap = args.maxMessages ?? 50;
  const concurrency = args.concurrency ?? 5;

  const refs: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;

  while (refs.length < cap) {
    const page = await listMessagesFn({
      accessToken,
      q: `newer_than:${windowExpr}`,
      maxResults: Math.min(100, cap - refs.length),
      pageToken,
    });

    refs.push(...page.messages);

    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  // Keep known SENT rows: the realtime path must still force the thread's reply re-eval.
  const { unknownRefs, knownRefs, knownSentDocs } = refs.length
    ? await partitionKnownGmailRefs(cred.userId, refs)
    : { unknownRefs: [], knownRefs: [], knownSentDocs: [] };

  let skipped = refs.length - unknownRefs.length;
  let inserted = 0;
  let ignored = 0;
  let errors = 0;
  let highWaterHistoryId: string | null = cursorBefore;
  const insertedDocumentIds: string[] = [];
  const triageDocumentIds: string[] = [];
  const sentDocumentIds: string[] = knownSentDocs.map((doc) => doc.documentId);

  const touchedThreadIds = new Set(
    knownSentDocs.map((doc) => doc.threadId).filter((threadId) => threadId !== null),
  );

  await mapConcurrent(unknownRefs, concurrency, async (ref) => {
    try {
      const message = await getMessageFn({ accessToken, id: ref.id, format: "full" });
      const result = await persistMessage(cred, message, accessToken);

      if (result.outcome === "inserted") {
        inserted++;
        insertedDocumentIds.push(result.documentId);

        if (result.isSent) sentDocumentIds.push(result.documentId);
        else triageDocumentIds.push(result.documentId);

        if (message.threadId) touchedThreadIds.add(message.threadId);
      } else if (result.outcome === "ignored") {
        ignored++;
      } else {
        // Raced `pollGmailHistory` or a duplicate webhook.
        skipped++;

        if (result.isSent) {
          sentDocumentIds.push(result.documentId);

          if (message.threadId) touchedThreadIds.add(message.threadId);
        }
      }

      await scheduleMediaAttachmentsAfterPersist({
        cred,
        message,
        persistResult: result,
        schedule: scheduleMediaIngest,
        logId: ref.id,
      });

      if (
        message.historyId &&
        (!highWaterHistoryId || compareHistoryIds(message.historyId, highWaterHistoryId) > 0)
      ) {
        highWaterHistoryId = message.historyId;
      }
    } catch (err) {
      errors++;
      console.warn(
        `[gmail.ingestor] poll-recent fetch failed for message=${ref.id}:`,
        toMessage(err),
      );
    }
  });

  // Re-schedule known messages still flagged `mediaPending`. The job fetches the message itself.
  if (knownRefs.length > 0 && scheduleMediaIngest) {
    await mapConcurrent(knownRefs, concurrency, async (ref) => {
      await scheduleGmailMediaIngestBestEffort({
        credentialId: args.credentialId,
        messageId: ref.id,
        documentId: ref.documentId,
        schedule: scheduleMediaIngest,
        logId: ref.id,
      });
    });
  }

  // A large jump from the cursor to the pushed id means the watch or the process was down. The 5m
  // search window cannot reach those events, so flag a coverage gap (#560b).
  const COVERAGE_GAP_THRESHOLD = 1000;
  let coverageGap = false;

  if (cursorBefore && latestReceiptHistoryId) {
    try {
      const jump = BigInt(latestReceiptHistoryId) - BigInt(cursorBefore);

      if (jump > BigInt(COVERAGE_GAP_THRESHOLD)) {
        coverageGap = true;
        console.warn(
          `[gmail.ingestor] coverage gap detected for ${args.credentialId}: ` +
            `cursor=${cursorBefore} push=${latestReceiptHistoryId} jump=${jump}`,
        );
      }
    } catch {
      // Non-numeric historyId: ignore.
    }
  }

  // Record webhook success even for an empty search. A partial failure may move the cursor, not the
  // success time.
  const cursorAdvanced = Boolean(highWaterHistoryId && highWaterHistoryId !== cursorBefore);

  if (cursorAdvanced || coverageGap || errors === 0) {
    await upsertIngestionState({
      credentialId: cred.credentialId,
      userId: cred.userId,
      historyId: highWaterHistoryId,
      fullSync: false,
      coverageGap,
      webhookSyncCompleted: errors === 0,
    });
  }

  return {
    listed: refs.length,
    inserted,
    skipped,
    ignored,
    errors,
    cursorBefore,
    cursorAfter: highWaterHistoryId,
    insertedDocumentIds,
    unembeddedDocumentIds: insertedDocumentIds,
    triageDocumentIds,
    sentDocumentIds,
    touchedThreadIds: Array.from(touchedThreadIds),
    userId: cred.userId,
  };
}

interface KnownSentGmailDoc {
  documentId: string;
  threadId: string | null;
}

async function partitionKnownGmailRefs(
  userId: string,
  refs: { id: string; threadId: string }[],
): Promise<{
  unknownRefs: { id: string; threadId: string }[];
  /** Known messages flagged `mediaPending`, to re-schedule. */
  knownRefs: { id: string; threadId: string; documentId: string }[];
  knownSentDocs: KnownSentGmailDoc[];
}> {
  const ids = refs.map((r) => r.id);

  const existing = await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      sourceThreadId: documents.sourceThreadId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        inArray(documents.sourceId, ids),
      ),
    );

  const known = new Map(existing.map((row) => [row.sourceId, row]));
  const unknownRefs = refs.filter((r) => !known.has(r.id));

  const knownRefs = refs.flatMap((r) => {
    const row = known.get(r.id);

    return row !== undefined && isMediaPending(row.metadata)
      ? [{ id: r.id, threadId: r.threadId, documentId: row.id }]
      : [];
  });

  const knownSentDocs: KnownSentGmailDoc[] = [];

  for (const row of existing) {
    if (isSentGmailMetadata(row.metadata)) {
      knownSentDocs.push({ documentId: row.id, threadId: row.sourceThreadId });
    }
  }

  return { unknownRefs, knownRefs, knownSentDocs };
}

/** True when the mail row's metadata has `mediaPending: true`. */
function isMediaPending(metadata: unknown): boolean {
  return getPath(metadata, "mediaPending") === true;
}

/** Added message ids from a history entry. The caller dedupes. */
function collectAddedMessageIds(entry: GmailHistoryEntry): string[] {
  const out: string[] = [];

  for (const m of entry.messagesAdded ?? []) out.push(m.message.id);

  // `messages` is the union per the Gmail docs. Kept in case the historyTypes filter is dropped.
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

  // SAFETY: these cursors write this jsonb shape.
  const state = rows[0]?.state as { historyId?: string | null } | undefined;
  const id = state?.historyId;

  return id ?? null;
}

/** History cursor and coverage-gap flag for a credential. */
async function loadIngestionState(
  credentialId: string,
): Promise<{ historyId: string | null; coverageGap: boolean }> {
  const rows = await db()
    .select({ state: ingestionState.state })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );

  // SAFETY: same stored shape, plus the optional coverageGap flag.
  const state = rows[0]?.state as { historyId?: string | null; coverageGap?: boolean } | undefined;

  return {
    historyId: state?.historyId ?? null,
    coverageGap: state?.coverageGap === true,
  };
}

/** Highest pushed historyId from receipts; they land even when BullMQ dedups the job (#560b). */
async function loadHighestReceiptHistoryId(credentialId: string): Promise<string | null> {
  const { typedEventReceipts } = await import("@alfred/db/schemas");

  const rows = await db()
    .select({
      // Delivery order is not revision order. Validate the text, then compare exactly as numeric.
      historyId: max(sql<string>`CASE
        WHEN ${typedEventReceipts.historyId} ~ '^[0-9]+$'
        THEN ${typedEventReceipts.historyId}::numeric
      END`),
    })
    .from(typedEventReceipts)
    .where(eq(typedEventReceipts.credentialId, credentialId));

  return rows[0]?.historyId ?? null;
}

/**
 * Active Gmail cursors. The sweep omits `before`, so a recent poll cannot suppress catch-up. A
 * credential with no `ingestion_state` row is not returned.
 */
export async function findCredentialsNeedingPoll(
  before?: Date,
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
    .filter((r) => !before || !r.lastSyncAt || r.lastSyncAt < before)
    .map((r) => ({ credentialId: r.credentialId, userId: r.userId }));
}

import { mapConcurrent, parseEmailAddress, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, ingestionState, integrationCredentials } from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled, serverEnv } from "@alfred/env/server";
import { embedDocument } from "@alfred/ingestion";
import { and, eq, inArray, sql } from "drizzle-orm";
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
import { labelSelfAuthoredMail } from "./labels";

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
  /**
   * Whether this run should advance the Gmail history cursor / full-sync marker.
   * Keep true for normal catch-up ingestion. Set false for filtered replay-style
   * backfills, where advancing the cursor from a partial query would incorrectly
   * claim the whole mailbox has been scanned.
   */
  updateCursor?: boolean;
}

export interface IngestRecentResult {
  fetched: number;
  inserted: number;
  skipped: number;
  /** Self-authored mail dropped before becoming a document (issue #211) — distinct from `skipped` (dedupe no-op) so #211 stays observable in logs. */
  ignored: number;
  errors: number;
  /** New chunk rows written across freshly inserted documents. */
  chunksWritten: number;
  /** Inserted documents whose embed step failed (the doc row still landed). */
  embedFailures: number;
  /** Highest `historyId` we observed — m7c uses this to seed delta polling. */
  highWaterHistoryId: string | null;
  /** Document ids that were freshly inserted this run (skipped/conflict rows excluded). */
  insertedDocumentIds: string[];
  /**
   * Subset of `insertedDocumentIds` eligible for triage — sent mail excluded
   * (ADR-0051 #7: sent docs are ingested + embedded but never triaged/labeled).
   * Embed/index over `insertedDocumentIds`; fan triage over this.
   */
  triageDocumentIds: string[];
  /**
   * Inserted documents carrying Gmail's `SENT` label (the user's own outbound
   * mail). Never triaged/labeled (ADR-0051 #7), but the caller uses these to
   * re-evaluate the thread tag on an outbound reply (issue #282) — keying the
   * received-only classify on the thread's newest inbound doc.
   */
  sentDocumentIds: string[];
  /**
   * Distinct Gmail thread ids that received a freshly-inserted message this
   * run. The caller reconciles these threads' `documents` against the live
   * Gmail thread so dead/superseded message ids don't accumulate (issue #279).
   */
  touchedThreadIds: string[];
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
            toMessage(err),
          );
        }
      } else if (result.outcome === "ignored") {
        ignored++;
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
      console.warn(`[gmail.ingestor] failed message=${ref.id}:`, toMessage(err));
    }
  }

  if (args.updateCursor !== false) {
    await upsertIngestionState({
      credentialId: cred.credentialId,
      userId: cred.userId,
      historyId: highWaterHistoryId,
      fullSync: true,
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
       * Mail the user SENT (carries Gmail's `SENT` label). Ingested + embedded
       * like any other doc — chat recall over sent mail needs vectors (ADR-0051
       * #7) — but the caller must keep it OUT of the triage fan-out and the
       * sender-prior write-back (you are not a sender to triage or to cache).
       */
      isSent: boolean;
    }
  // Self-authored mail (From = Alfred's own send identity) — dropped before it
  // becomes a `documents` row, so there is nothing to embed, triage, or address
  // downstream (issue #211). Distinct from `skipped` (a dedupe no-op) in intent,
  // but callers handle it identically: the non-`inserted` branch counts it and
  // does nothing else.
  | { outcome: "ignored" };

/**
 * Alfred's own send identity, parsed from `RESEND_FROM_EMAIL` (e.g.
 * `"Alfred <hey@alfred.beauty>"`) — the single source of truth shared with
 * `@alfred/mailer`. Lazily resolved + cached for the process.
 */
let _selfSenderEmail: string | null | undefined;
export function selfSenderEmail(): string | null {
  if (_selfSenderEmail === undefined) {
    _selfSenderEmail = parseEmailAddress(serverEnv().RESEND_FROM_EMAIL);
  }
  return _selfSenderEmail;
}

/**
 * True when a message was sent by Alfred itself (briefing / approval mail,
 * `From` = `RESEND_FROM_EMAIL`). Alfred's outbound re-enters the connected
 * inbox as ordinary *inbound* mail — it carries no Gmail `SENT` label, so the
 * `isSent` guard never catches it. Left un-filtered it gets ingested, triaged
 * into the demanding lanes, and re-fed into the next briefing: a self-
 * amplifying loop (issue #211). Self-mail carries no signal Alfred didn't
 * itself author, so we drop it before it becomes a `documents` row.
 */
export function isSelfAuthored(from: string | null): boolean {
  const self = selfSenderEmail();
  return self !== null && parseEmailAddress(from) === self;
}

async function persistMessage(
  cred: CredentialContext,
  message: GmailMessage,
  accessToken: string,
): Promise<PersistMessageResult> {
  const { userId, accountId } = cred;
  const extracted = extractMessageContent(message);
  // Drop Alfred's own outbound mail before it becomes a document — see
  // `isSelfAuthored` (issue #211). Nothing downstream should ever see it.
  if (isSelfAuthored(extracted.from)) {
    // But don't let it vanish: tag it with the dedicated Alfred label so the
    // briefing + approval stream is findable in Gmail (issue #285). Best-effort
    // — a labelling failure must never block the drop, which is the actual
    // self-loop guardrail. The message stays out of `documents`, triage, and
    // the sender-prior cache regardless.
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
  const content = buildContent(extracted);
  const contentHash = sha256(content);
  const labelIds = message.labelIds ?? [];
  const isSent = labelIds.includes("SENT");

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
      raw: message,
      authoredAt: extracted.date ?? internalDateToDate(message.internalDate),
      metadata: {
        from: extracted.from,
        to: extracted.to,
        cc: extracted.cc,
        labelIds,
        isSent,
        internalDate: message.internalDate,
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
    return { outcome: "inserted", documentId: inserted[0].id, isSent };
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
  return { outcome: "skipped", documentId: existingId, isSent };
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
  const newId = args.historyId; // string | null — drizzle binds null as SQL NULL
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
        // Compare-and-advance on historyId at the DB level. Two writers
        // (realtime `pollGmailRecent` + catch-up `pollGmailHistory`) can race
        // on this row; the application-level snapshot (`cursorBefore`) is
        // already stale by the time we write back, so a naive `jsonb_set`
        // could roll the cursor backward and force a wider re-scan on the
        // next catch-up. CASE arms (PG short-circuits the WHEN list in
        // order): keep existing if (a) we observed no new id, (b) cursor
        // exists and the new id isn't strictly greater. Only when the new
        // id is null OR strictly higher do we touch state.historyId.
        // `lastSyncAt`/`updatedAt` still update unconditionally so
        // findCredentialsNeedingPoll sees the credential as fresh.
        // (ADR-0037)
        state: sql`
          jsonb_set(
            ${ingestionState.state},
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
  /** Self-authored mail dropped before becoming a document (issue #211). */
  ignored: number;
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
  /** Document ids that were freshly inserted this run. */
  insertedDocumentIds: string[];
  /** Non-sent subset of `insertedDocumentIds` — the ids the caller fans triage runs over. */
  triageDocumentIds: string[];
  /** Inserted SENT docs — drive the reply-re-eval (issue #282). */
  sentDocumentIds: string[];
  /** Threads with a fresh insert — reconciled against live Gmail (issue #279). */
  touchedThreadIds: string[];
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
      ignored: recent.ignored,
      errors: recent.errors,
      chunksWritten: recent.chunksWritten,
      embedFailures: recent.embedFailures,
      cursorBefore: null,
      cursorAfter: recent.highWaterHistoryId,
      fullResync: true,
      insertedDocumentIds: recent.insertedDocumentIds,
      triageDocumentIds: recent.triageDocumentIds,
      sentDocumentIds: recent.sentDocumentIds,
      touchedThreadIds: recent.touchedThreadIds,
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
        ignored: recent.ignored,
        errors: recent.errors,
        chunksWritten: recent.chunksWritten,
        embedFailures: recent.embedFailures,
        cursorBefore,
        cursorAfter: recent.highWaterHistoryId,
        fullResync: true,
        insertedDocumentIds: recent.insertedDocumentIds,
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

  for (const id of messageIds) {
    try {
      const message = await getMessage({ accessToken, id, format: "full" });
      const result = await persistMessage(cred, message, accessToken);
      if (result.outcome === "inserted") {
        inserted++;
        insertedDocumentIds.push(result.documentId);
        if (result.isSent) sentDocumentIds.push(result.documentId);
        else triageDocumentIds.push(result.documentId);
        if (message.threadId) touchedThreadIds.add(message.threadId);
        try {
          const embed = await embedDocument({ documentId: result.documentId });
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
      }
    } catch (err) {
      errors++;
      console.warn(`[gmail.ingestor] poll fetch failed for message=${id}:`, toMessage(err));
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
    ignored,
    errors,
    chunksWritten,
    embedFailures,
    cursorBefore,
    cursorAfter: latestHistoryId,
    fullResync: false,
    insertedDocumentIds,
    triageDocumentIds,
    sentDocumentIds,
    touchedThreadIds: Array.from(touchedThreadIds),
    userId: cred.userId,
  };
}

// ---------------------------------------------------------------------------
// Realtime sync via users.messages.list (ADR-0037)
// ---------------------------------------------------------------------------

export interface PollRecentArgs {
  credentialId: string;
  /** Search window passed to `newer_than:<window>`. Default `5m`. */
  window?: string;
  /** Soft cap on messages considered in one call. Default 50. */
  maxMessages?: number;
  /**
   * Bounded concurrency for the per-message `getMessage` + `persistMessage`
   * phase. Default 5. Gmail's per-user QPS comfortably absorbs this and a
   * 1-message webhook short-circuits to serial anyway.
   */
  concurrency?: number;
}

export interface PollRecentResult {
  /** Messages returned by `messages.list`. */
  listed: number;
  /** Freshly persisted documents. */
  inserted: number;
  /** Messages we already had (dedupe hit on `(userId, source, sourceId)`). */
  skipped: number;
  /** Self-authored mail dropped before becoming a document (issue #211). */
  ignored: number;
  errors: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  insertedDocumentIds: string[];
  /** Non-sent subset of `insertedDocumentIds` — the ids the caller fans triage runs over. */
  triageDocumentIds: string[];
  /** Inserted SENT docs — drive the reply-re-eval (issue #282). */
  sentDocumentIds: string[];
  /** Threads with a fresh insert — reconciled against live Gmail (issue #279). */
  touchedThreadIds: string[];
  userId: string;
}

/**
 * Realtime fetch driven by pub/sub. Uses Gmail's search index
 * (`users.messages.list`) instead of the change-log API
 * (`users.history.list`) — the search index updates within seconds of
 * a message arriving, where the history index can lag pub/sub by
 * minutes (ADR-0037).
 *
 * Contract:
 *  - Lists messages with `newer_than:<window>` (default 5m), capped.
 *  - One indexed SELECT drops ids we already have BEFORE we spend a
 *    `messages.get` roundtrip on them.
 *  - Fetches + persists the remainder concurrently via the same
 *    `persistMessage` path as the bulk + delta ingestors, so dedupe
 *    behaves identically.
 *  - Advances the history cursor to the max observed `historyId`, but
 *    only forward — never rolls it back. `pollGmailHistory` (poll-
 *    fallback) reads the same cursor and stays consistent.
 *  - **Does not embed.** The caller (`queue.ts`) enqueues triage on the
 *    inserted ids first, then runs `embedDocument` best-effort; this
 *    keeps Voyage latency off the user-visible tag-latency path.
 *
 * `history.list` remains the right shape for catch-up after extended
 * downtime; this function does not replace it. The 5-min poll-fallback
 * (which calls `pollGmailHistory`) is the safety net for any window
 * this path misses (bursts > maxMessages, search-index quirks, etc).
 */
export async function pollGmailRecent(args: PollRecentArgs): Promise<PollRecentResult> {
  // Header loads are independent (cred row, token refresh, cursor row).
  // Running them serially added ~40-60ms to every webhook for no reason;
  // any contention is harmless — both cred reads are SELECTs on the same
  // pk and the cursor lives in a different table.
  const [cred, accessToken, cursorBefore] = await Promise.all([
    loadCredentialOrThrow(args.credentialId),
    getFreshAccessToken(args.credentialId),
    loadHistoryCursor(args.credentialId),
  ]);

  const windowExpr = args.window ?? "5m";
  const cap = args.maxMessages ?? 50;
  const concurrency = args.concurrency ?? 5;

  const refs: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  while (refs.length < cap) {
    const page = await listMessages({
      accessToken,
      q: `newer_than:${windowExpr}`,
      maxResults: Math.min(100, cap - refs.length),
      pageToken,
    });
    refs.push(...page.messages);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  // Drop refs we've already persisted. One indexed lookup beats N
  // `messages.get` roundtrips — typical webhook returns 1-3 ids and
  // the catch-up sweep often beat us to a subset.
  const unknownRefs = refs.length ? await filterKnownGmailIds(cred.userId, refs) : [];
  let skipped = refs.length - unknownRefs.length;
  let inserted = 0;
  let ignored = 0;
  let errors = 0;
  let highWaterHistoryId: string | null = cursorBefore;
  const insertedDocumentIds: string[] = [];
  const triageDocumentIds: string[] = [];
  const sentDocumentIds: string[] = [];
  const touchedThreadIds = new Set<string>();

  await mapConcurrent(unknownRefs, concurrency, async (ref) => {
    try {
      const message = await getMessage({ accessToken, id: ref.id, format: "full" });
      const result = await persistMessage(cred, message, accessToken);
      if (result.outcome === "inserted") {
        inserted++;
        insertedDocumentIds.push(result.documentId);
        if (result.isSent) sentDocumentIds.push(result.documentId);
        else triageDocumentIds.push(result.documentId);
        if (message.threadId) touchedThreadIds.add(message.threadId);
      } else if (result.outcome === "ignored") {
        // Self-authored mail (issue #211) — dropped, never a document.
        ignored++;
      } else {
        // A race against pollGmailHistory or a duplicate webhook fired
        // between the pre-filter SELECT and the insert. Rare but fine.
        skipped++;
      }
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

  // Skip the DB roundtrip when our in-memory snapshot already shows no
  // advance — highWaterHistoryId starts as cursorBefore and only moves
  // forward, so a strict-inequality check here is sound. The DB-level
  // compare-and-advance in `upsertIngestionState` is the actual guard
  // against a concurrent `pollGmailHistory` rolling the cursor backward;
  // this branch is just an optimization to avoid a wasted UPDATE on the
  // common no-op case (webhook fires for a label change with no new mail).
  if (highWaterHistoryId && highWaterHistoryId !== cursorBefore) {
    await upsertIngestionState({
      credentialId: cred.credentialId,
      userId: cred.userId,
      historyId: highWaterHistoryId,
      fullSync: false,
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
    triageDocumentIds,
    sentDocumentIds,
    touchedThreadIds: Array.from(touchedThreadIds),
    userId: cred.userId,
  };
}

/** Drop refs whose Gmail id already maps to a `documents` row for this user. */
async function filterKnownGmailIds(
  userId: string,
  refs: { id: string; threadId: string }[],
): Promise<{ id: string; threadId: string }[]> {
  const ids = refs.map((r) => r.id);
  const existing = await db()
    .select({ sourceId: documents.sourceId })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        inArray(documents.sourceId, ids),
      ),
    );
  const known = new Set(existing.map((r) => r.sourceId));
  return refs.filter((r) => !known.has(r.id));
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

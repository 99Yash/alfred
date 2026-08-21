import {
  gmailDocumentMetadataSchema,
  isRecord,
  mapConcurrent,
  parseGmailDocumentMetadata,
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
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  hasIngestableAttachments,
  ingestGmailMediaAttachments,
  internalDateToDate,
  setMediaPending,
  ZERO_MEDIA_TALLY,
  type GmailMediaIngestDeps,
  type GmailMediaIngestResult,
} from "./gmail-media";

/**
 * Gmail ingestion orchestration. Relocated out of `@alfred/integrations`
 * (`google/ingestor.ts`) so the provider package stays provider-only: it now
 * exposes only fetch/normalize/OAuth/watch/label primitives, and this api-layer
 * consumer owns the ingestion-domain writes — the `documents` + `ingestion_state`
 * rows and the `@alfred/corpus` index. Behavior is byte-identical to the former
 * provider-resident code; only the home changed.
 *
 * One-shot ingestion of recent Gmail messages for a credential.
 *
 * m7a deliberately skips chunking and embedding — we just want to prove
 * the OAuth → list → fetch → write loop works end-to-end. m7b lands the
 * chunker + Voyage embedding pipeline that backfills `chunks` from
 * `documents` (no re-fetching from Gmail required).
 */

/**
 * Deferred attachment ingest (ADR-0091 amendment): the poll paths never run
 * fetch + child-process parse inline — a message with several attachments
 * could hold the poll job for minutes and delay cursor advance and sibling
 * messages. Instead they schedule one `gmail.media_ingest` job per message
 * (`queue.ts` owns the real enqueue; tests inject a recorder).
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
   * Whether this run should advance the Gmail history cursor / full-sync marker.
   * Keep true for normal catch-up ingestion. Set false for filtered replay-style
   * backfills, where advancing the cursor from a partial query would incorrectly
   * claim the whole mailbox has been scanned.
   */
  updateCursor?: boolean | undefined;
  /** #560b: set true when this ingest covers a detected coverage gap. */
  coverageGap?: boolean | undefined;
  /** Deferred attachment ingest sink. Production wires `enqueueGmailMediaIngest`. */
  scheduleMediaIngest?: ScheduleGmailMediaIngest | undefined;
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
   * Freshly-inserted docs the caller still needs to embed. This is the owner of
   * the embed-policy fact: `[]` here because this bulk path embeds every insert
   * inline (see the `indexDocument` call in the loop), so nothing is left for the
   * corpus consumer.
   */
  unembeddedDocumentIds: string[];
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
    // Inline embed above already covered every insert — nothing deferred.
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
  // does nothing else. The `isSelfAuthored` guard is a pure identity helper that
  // stays in the provider package (`@alfred/integrations/google`).
  | { outcome: "ignored" };

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
  // we've already seen does not re-write the row. A subject or body
  // change for the same Gmail `id` is intentionally NOT reflected —
  // first-seen wins and the mail doc is immutable for the current
  // product (the update would need `onConflictDoUpdate`). The name
  // `skipped` reflects this: a conflict is a dedupe no-op, not a
  // deferred update.
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

/**
 * Single owner for post-persist attachment scheduling. Centralizes the
 * `ignored` (self-authored) and no-attachment guards so a new ingest path
 * cannot forget them, and keeps domain order explicit: persist message →
 * schedule attachments. Never runs extraction inline (ADR-0091 amendment):
 * a five-attachment message must not hold the poll for minutes.
 */
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
 * Flag-first scheduling. The mail row carries `mediaPending` until a
 * `gmail.media_ingest` job completes cleanly, so a lost or failed enqueue is
 * recovered by the next poll's flagged-known-message pass (and BullMQ's own
 * attempts cover transient job failures). A failed flag write only costs one
 * extra dedup-only retry; a failed schedule with the flag set is retried on
 * the next poll.
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
 * Job-side runner for `gmail.media_ingest`. Fetches the full message fresh
 * (the poll paths no longer carry it), re-applies the self-authored guard as
 * belt-and-suspenders for rows written before the current rule, runs the
 * attachment ingest loop, then resolves the `mediaPending` flag by outcome:
 * cleared on a clean pass, held on any fetch/extract/persist error so the
 * next poll re-schedules. Embed failures are not flagged — the corpus sweep
 * recovers those (`gmail.embed_sweep` covers `gmail_attachment` rows).
 */
export async function runGmailMediaIngest(args: {
  credentialId: string;
  messageId: string;
  documentId: string;
  /** Test seam — overrides Gmail I/O and attachment ingest deps. */
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
    ...(args.deps?.media ? { deps: args.deps.media } : {}),
  });
  if (result.errors > 0 || result.embedFailures > 0) {
    console.warn(
      `[gmail.media] job mediaErrors=${result.errors} mediaEmbedFailures=${result.embedFailures} ` +
        `for message=${args.messageId}`,
    );
  }
  await setMediaPending(args.documentId, result.errors > 0);
  return result;
}

export interface RunGmailMediaIngestDeps {
  getFreshAccessToken?: typeof getFreshAccessToken | undefined;
  getMessage?: typeof getMessage | undefined;
  media?: GmailMediaIngestDeps | undefined;
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
  /** #560b: set true when a coverage gap is detected (history gone or cursor jump). */
  coverageGap?: boolean;
}

async function upsertIngestionState(args: UpsertIngestionStateArgs): Promise<void> {
  const now = new Date();
  const newId = args.historyId; // string | null — drizzle binds null as SQL NULL
  // #560b: merge coverageGap and lastPushHistoryId into the JSONB state.
  // coverageGap clears automatically when the cursor advances (Blocker 4 fix).
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
        lastFullSyncAt: args.fullSync ? now : ingestionState.lastFullSyncAt,
        updatedAt: now,
      },
    });
}

/**
 * Seed the rolling Gmail history cursor for a credential when no cursor row
 * exists yet. Relocated from the provider package's `watch.ts` so the provider
 * no longer writes `ingestion_state`: `installGmailWatch` returns its watch
 * state and this consumer seeds the cursor. A renewal must NOT reset an existing
 * cursor — that would skip everything between the last poll and now — so the
 * seed is guarded by an existence check plus `onConflictDoNothing`.
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

  // No prior cursor → seed one. Look up userId from the credential row;
  // we need it for the not-null FK.
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
 * Install (or renew) a Gmail watch channel, then seed the rolling history
 * cursor when the channel actually installed. The single app entry point for
 * watch installation: the provider `installGmailWatch` no longer seeds the
 * cursor (it is a provider-only package now), so every install site MUST route
 * through this wrapper — otherwise a freshly-watched credential gets no cursor
 * and `pollGmailHistory` falls into a perpetual full re-sync. A `null` state
 * (mailbox writes disabled, #278) means no watch was registered, so there is
 * nothing to seed.
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

export interface PollHistoryArgs {
  credentialId: string;
  /**
   * Cap on history pages walked in one call. Each page can yield up to
   * 500 entries; the cap is a defense against runaway loops if a watch
   * channel went silent for days and the history is huge.
   */
  maxPages?: number | undefined;
  /** Deferred attachment ingest sink. Production wires `enqueueGmailMediaIngest`. */
  scheduleMediaIngest?: ScheduleGmailMediaIngest | undefined;
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
  /**
   * Freshly-inserted docs the caller still needs to embed. `[]` on the main
   * history-poll path (it embeds inline); the cursorless / history-gone
   * fallbacks delegate to `ingestRecentGmail` and forward its value.
   */
  unembeddedDocumentIds: string[];
  /** Non-sent subset of `insertedDocumentIds` — the ids the caller fans triage runs over. */
  triageDocumentIds: string[];
  /**
   * SENT docs observed by this history poll that should drive reply re-eval
   * (issue #282). Includes skipped rows when another ingestion path inserted
   * the same sent copy first.
   */
  sentDocumentIds: string[];
  /** Threads with a fresh insert or observed SENT row — reconciled against live Gmail (issue #279). */
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
      // Fallback delegates to ingestRecentGmail, its true owner — forward, don't re-derive.
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
        coverageGap: true,
        scheduleMediaIngest: args.scheduleMediaIngest,
      });
      // #560b: clear coverageGap after the full re-sync repair. The
      // ingestRecentGmail call above set it to true (which is correct for
      // the audit trail), but the gap is now closed and triggerReady must
      // recover. The cursor has advanced, so the SQL CASE clears the flag.
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
        // Fallback delegates to ingestRecentGmail, its true owner — forward, don't re-derive.
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
    // Main history-poll path embeds inline — nothing deferred.
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
  /** Search window passed to `newer_than:<window>`. Default `5m`. */
  window?: string | undefined;
  /** Soft cap on messages considered in one call. Default 50. */
  maxMessages?: number | undefined;
  /**
   * Bounded concurrency for the per-message `getMessage` + `persistMessage`
   * phase. Default 5. Gmail's per-user QPS comfortably absorbs this and a
   * 1-message webhook short-circuits to serial anyway.
   */
  concurrency?: number | undefined;
  /** #560b: Pub/Sub push historyId for cursor-jump gap detection. */
  pushHistoryId?: string | undefined;
  /** Test seam — overrides Gmail I/O and media ingestion deps. */
  deps?: PollRecentDeps | undefined;
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
  /**
   * Freshly-inserted docs the caller still needs to embed. This realtime path
   * is the ONLY deferred-embed path (it returns before embedding to keep Voyage
   * latency off the tag-latency budget — ADR-0037), so this equals exactly the
   * freshly-inserted ids: `insertedDocumentIds`, never the observed-SENT rows.
   */
  unembeddedDocumentIds: string[];
  /** Non-sent subset of `insertedDocumentIds` — the ids the caller fans triage runs over. */
  triageDocumentIds: string[];
  /**
   * SENT docs observed by this realtime poll that should drive reply re-eval
   * (issue #282). Includes skipped rows when the 5-min catch-up path inserted
   * the same sent copy first.
   */
  sentDocumentIds: string[];
  /** Threads with a fresh insert or observed SENT row — reconciled against live Gmail (issue #279). */
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
 *  - One indexed SELECT drops already-known non-SENT ids before we spend a
 *    `messages.get` roundtrip on them. Already-known SENT rows are still
 *    surfaced to the caller so outbound replies trigger reply re-eval.
 *  - Advances the history cursor to the max observed `historyId`, but
 *    only forward — never rolls it back. `pollGmailHistory` (poll-
 *    fallback) reads the same cursor and stays consistent.
 *  - **Does not embed.** The caller (`queue.ts`) enqueues triage on the
 *    inserted ids first, then runs `indexDocument` best-effort; this
 *    keeps Voyage latency off the user-visible tag-latency path.
 *
 * `history.list` remains the right shape for catch-up after extended
 * downtime; this function does not replace it. The 5-min poll-fallback
 * (which calls `pollGmailHistory`) is the safety net for any window
 * this path misses (bursts > maxMessages, search-index quirks, etc).
 */
export async function pollGmailRecent(args: PollRecentArgs): Promise<PollRecentResult> {
  const listMessagesFn = args.deps?.listMessages ?? listMessages;
  const getMessageFn = args.deps?.getMessage ?? getMessage;
  const getFreshAccessTokenFn = args.deps?.getFreshAccessToken ?? getFreshAccessToken;
  const scheduleMediaIngest = args.deps?.scheduleMediaIngest;
  // Header loads are independent (cred row, token refresh, cursor row).
  // Running them serially added ~40-60ms to every webhook for no reason;
  // any contention is harmless — both cred reads are SELECTs on the same
  // pk and the cursor lives in a different table.
  const [cred, accessToken, state] = await Promise.all([
    loadCredentialOrThrow(args.credentialId),
    getFreshAccessTokenFn(args.credentialId),
    loadIngestionState(args.credentialId),
  ]);
  const cursorBefore = state.historyId;

  // #560b: read the latest push-delivered historyId from event_receipts.
  // Receipts are written by every webhook handler, even when the queue
  // deduplicates the job, so this value reflects the highest historyId
  // we have seen regardless of BullMQ dedup.
  const latestReceiptHistoryId = await loadLatestReceiptHistoryId(args.credentialId);

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

  // Preserve the indexed pre-filter for the latency path, but do not drop known
  // SENT rows on the floor. A sent copy may have been inserted by history
  // catch-up or a prior attempt that died before side effects; the realtime
  // webhook must still force the thread's reply re-eval.
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
        // Self-authored mail (issue #211) — dropped, never a document.
        ignored++;
      } else {
        // A race against pollGmailHistory or a duplicate webhook. Rare but fine.
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

  // Re-schedule attachment ingest for known messages whose mail row carries
  // the `mediaPending` flag from a lost or failed job. No `messages.get`
  // roundtrip here — the flag alone identifies the retry set, and the job
  // fetches the full message itself.
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

  // #560b: detect a coverage gap when the Pub/Sub push historyId is far ahead
  // of our stored cursor. A large jump means the watch was down or the process
  // was offline for a period — events in between were never polled. The 5m
  // search window cannot reach them, so the trigger readiness gate must know.
  // #560b: detect coverage gaps by comparing the cursor against the latest
  // push-delivered historyId from event_receipts. Receipts are written by
  // every webhook, even when the queue deduplicates the job, so gap
  // detection works regardless of whether BullMQ dropped a duplicate push.
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
      // Non-numeric historyId — ignore; the cursor will advance normally.
    }
  }

  // #560b: write the state when the cursor advanced OR a coverage gap was
  // detected. The original guard skipped the DB roundtrip when the in-memory
  // snapshot showed no advance, but that also discarded the coverageGap flag
  // when the5-minute search window found nothing (the flag's primary case).
  const cursorAdvanced = Boolean(highWaterHistoryId && highWaterHistoryId !== cursorBefore);
  if (cursorAdvanced || coverageGap) {
    await upsertIngestionState({
      credentialId: cred.credentialId,
      userId: cred.userId,
      historyId: highWaterHistoryId,
      fullSync: false,
      coverageGap,
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
    // Deferred embed: hand the corpus consumer exactly the freshly-inserted ids.
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
  /** Known messages whose mail row carries `mediaPending` — the only ones the retry re-schedules. */
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
  const knownRefs = refs
    .filter((r) => {
      const row = known.get(r.id);
      return row !== undefined && isMediaPending(row.metadata);
    })
    .map((r) => {
      const row = known.get(r.id)!;
      return { id: r.id, threadId: r.threadId, documentId: row.id };
    });
  const knownSentDocs: KnownSentGmailDoc[] = [];
  for (const row of existing) {
    if (isStoredGmailSentMetadata(row.metadata)) {
      knownSentDocs.push({ documentId: row.id, threadId: row.sourceThreadId });
    }
  }
  return { unknownRefs, knownRefs, knownSentDocs };
}

/**
 * Read the `mediaPending` retry flag off a mail row's jsonb metadata. The
 * flag is written by `setMediaPending` after a failed attachment attempt;
 * absent or non-true means "no retry needed".
 */
function isMediaPending(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  return metadata.mediaPending === true;
}

function isStoredGmailSentMetadata(metadata: unknown): boolean {
  const parsed = parseGmailDocumentMetadata(metadata);
  return parsed.isSent === true || parsed.labelIds?.includes("SENT") === true;
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
 * Return the ingestion state for a credential — history cursor and coverage
 * gap flag.
 */
async function loadIngestionState(
  credentialId: string,
): Promise<{ historyId: string | null; coverageGap: boolean }> {
  const rows = await db()
    .select({ state: ingestionState.state })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );
  const state = rows[0]?.state as { historyId?: string | null; coverageGap?: boolean } | undefined;
  return {
    historyId: state?.historyId ?? null,
    coverageGap: state?.coverageGap === true,
  };
}

/**
 * #560b: read the latest push-delivered historyId from event_receipts for a
 * credential. This is the source of truth for gap detection — receipts are
 * written by every webhook, even when the queue deduplicates the job, so this
 * value reflects the highest historyId we have seen regardless of job dedup.
 */
async function loadLatestReceiptHistoryId(credentialId: string): Promise<string | null> {
  const { eventReceipts } = await import("@alfred/db/schemas");
  const rows = await db()
    .select({ historyId: eventReceipts.historyId })
    .from(eventReceipts)
    .where(eq(eventReceipts.credentialId, credentialId))
    .orderBy(sql`${eventReceipts.deliveredAt} DESC`)
    .limit(1);
  return rows[0]?.historyId ?? null;
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

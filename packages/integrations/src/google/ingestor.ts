import { db } from "@alfred/db";
import { documents, ingestionState } from "@alfred/db/schemas";
import { embedDocument } from "@alfred/ingestion";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getFreshAccessToken } from "./credentials";
import {
  extractMessageContent,
  getMessage,
  listMessages,
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

  for (const ref of refs) {
    try {
      const message = await getMessage({ accessToken, id: ref.id, format: "full" });
      const result = await persistMessage(cred.userId, cred.accountId, message);
      if (result.outcome === "inserted") {
        inserted++;
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

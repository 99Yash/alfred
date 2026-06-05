import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import type { TriageCategory } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";

/**
 * Persistence helpers for the thread-keyed triage table. The workflow owns
 * the LLM call and the Gmail label-write; this module is pure DB access.
 * One row per (userId, sourceThreadId) — every new message in the thread
 * re-classifies and overwrites this row.
 */

export interface TriageRow {
  userId: string;
  sourceThreadId: string;
  documentId: string | null;
  category: TriageCategory;
  confidence: number;
  rationale: string | null;
  model: string;
  appliedLabelId: string | null;
  classifiedAt: Date;
  runId: string | null;
}

export async function getTriage(userId: string, sourceThreadId: string): Promise<TriageRow | null> {
  const rows = await db()
    .select()
    .from(emailTriage)
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));
  const row = rows[0];
  if (!row) return null;
  return rowToTriage(row);
}

export interface UpsertTriageArgs {
  userId: string;
  sourceThreadId: string;
  documentId: string;
  category: TriageCategory;
  confidence: number;
  rationale: string | null;
  model: string;
  runId: string | null;
  appliedLabelId?: string | null;
}

/**
 * Insert or update the thread's triage row. Re-classification on a new
 * message in the thread overwrites in place; the row always reflects the
 * latest message's outcome.
 *
 * `appliedLabelId` is left untouched if the caller doesn't pass it — that
 * lets the classify step write the row before knowing the Gmail label and
 * the label-write step update just the `appliedLabelId` column.
 */
export async function upsertTriage(args: UpsertTriageArgs): Promise<TriageRow> {
  const now = new Date();
  const updateSet: Record<string, unknown> = {
    category: args.category,
    confidence: args.confidence,
    rationale: args.rationale,
    model: args.model,
    documentId: args.documentId,
    classifiedAt: now,
    runId: args.runId,
    updatedAt: now,
  };
  if (args.appliedLabelId !== undefined) {
    updateSet.appliedLabelId = args.appliedLabelId;
  }

  const result = await db()
    .insert(emailTriage)
    .values({
      userId: args.userId,
      sourceThreadId: args.sourceThreadId,
      documentId: args.documentId,
      category: args.category,
      confidence: args.confidence,
      rationale: args.rationale,
      model: args.model,
      classifiedAt: now,
      runId: args.runId,
      appliedLabelId: args.appliedLabelId ?? null,
    })
    .onConflictDoUpdate({
      target: [emailTriage.userId, emailTriage.sourceThreadId],
      set: updateSet,
    })
    .returning();
  const row = result[0];
  if (!row) {
    throw new Error(
      `[triage] upsert returned no row for user=${args.userId} thread=${args.sourceThreadId}`,
    );
  }
  return rowToTriage(row);
}

/**
 * Update only the `applied_label_id` on a thread's triage row — used by
 * the label-write step after Gmail's `messages.modify` succeeds.
 */
export async function setAppliedLabelId(
  userId: string,
  sourceThreadId: string,
  appliedLabelId: string,
): Promise<void> {
  await db()
    .update(emailTriage)
    .set({ appliedLabelId, updatedAt: new Date() })
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));
}

/**
 * Authored timestamp of a single document, or null if the row is absent or
 * carries no `authored_at`. The triage already-tagged guard uses this to
 * decide whether an incoming message is genuinely newer than the one the
 * thread was last classified from — i.e. a reply worth re-evaluating vs a
 * re-delivered / out-of-order / duplicate message worth skipping.
 */
export async function getDocumentAuthoredAt(
  userId: string,
  documentId: string,
): Promise<Date | null> {
  const rows = await db()
    .select({ authoredAt: documents.authoredAt })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
      ),
    );
  return rows[0]?.authoredAt ?? null;
}

export interface TriageDocumentContext {
  document: {
    id: string;
    userId: string;
    sourceId: string;
    sourceThreadId: string | null;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    metadata: Record<string, unknown>;
  };
  /** Resolved Gmail credential for the doc's account. */
  credentialId: string;
  /**
   * Account persona for the credential (`'work' | 'personal' | null`) — fed to
   * the triage classifier as a one-line context hint (ADR-0051 §3). Null for
   * legacy credentials connected before persona auto-detection.
   */
  persona: string | null;
}

/**
 * Load a Gmail document plus the credential id needed to write labels back.
 * Throws when the doc isn't from Gmail or the credential is gone — both are
 * unrecoverable for the workflow.
 */
export async function loadTriageContext(
  documentId: string,
  userId: string,
): Promise<TriageDocumentContext | null> {
  const docRows = await db()
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId)));
  const doc = docRows[0];
  if (!doc) return null;
  if (doc.source !== "gmail") {
    throw new Error(`[triage] document ${documentId} has source=${doc.source}, expected gmail`);
  }
  if (!doc.accountId) {
    throw new Error(`[triage] document ${documentId} missing accountId`);
  }

  const credRows = await db()
    .select({ id: integrationCredentials.id, persona: integrationCredentials.persona })
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.userId, userId),
        eq(integrationCredentials.provider, "google"),
        eq(integrationCredentials.accountId, doc.accountId),
      ),
    );
  const cred = credRows[0];
  if (!cred) {
    throw new Error(`[triage] no google credential for user=${userId} account=${doc.accountId}`);
  }

  return {
    document: {
      id: doc.id,
      userId: doc.userId,
      sourceId: doc.sourceId,
      sourceThreadId: doc.sourceThreadId,
      title: doc.title,
      content: doc.content,
      authoredAt: doc.authoredAt,
      metadata: (doc.metadata as Record<string, unknown> | null) ?? {},
    },
    credentialId: cred.id,
    persona: cred.persona ?? null,
  };
}

function rowToTriage(row: typeof emailTriage.$inferSelect): TriageRow {
  return {
    userId: row.userId,
    sourceThreadId: row.sourceThreadId,
    documentId: row.documentId,
    category: row.category as TriageCategory,
    confidence: row.confidence,
    rationale: row.rationale,
    model: row.model,
    appliedLabelId: row.appliedLabelId,
    classifiedAt: row.classifiedAt,
    runId: row.runId,
  };
}

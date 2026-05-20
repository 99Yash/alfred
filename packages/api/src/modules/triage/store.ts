import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import type { TriageCategory } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";

/**
 * Persistence helpers for the triage table. The workflow owns the LLM call
 * and the Gmail label-write; this module is pure DB access — easy to mock,
 * easy to read.
 */

export interface TriageRow {
  documentId: string;
  userId: string;
  category: TriageCategory;
  confidence: number;
  rationale: string | null;
  model: string;
  appliedLabelId: string | null;
  classifiedAt: Date;
  runId: string | null;
}

export async function getTriage(documentId: string): Promise<TriageRow | null> {
  const rows = await db().select().from(emailTriage).where(eq(emailTriage.documentId, documentId));
  const row = rows[0];
  if (!row) return null;
  return {
    documentId: row.documentId,
    userId: row.userId,
    category: row.category as TriageCategory,
    confidence: row.confidence,
    rationale: row.rationale,
    model: row.model,
    appliedLabelId: row.appliedLabelId,
    classifiedAt: row.classifiedAt,
    runId: row.runId,
  };
}

export interface UpsertTriageArgs {
  documentId: string;
  userId: string;
  category: TriageCategory;
  confidence: number;
  rationale: string | null;
  model: string;
  runId: string | null;
  appliedLabelId?: string | null;
}

/**
 * Insert or update the triage row. Re-classification overwrites in place
 * (we keep one canonical row per document); audit lives on `api_call_log`
 * + `agent_runs`.
 *
 * `appliedLabelId` is left untouched if the caller doesn't pass it — that
 * lets the classify step write the row without knowing the Gmail label,
 * and the label-write step update only the `appliedLabelId` column.
 */
export async function upsertTriage(args: UpsertTriageArgs): Promise<TriageRow> {
  const now = new Date();
  const baseSet: Record<string, unknown> = {
    category: args.category,
    confidence: args.confidence,
    rationale: args.rationale,
    model: args.model,
    classifiedAt: now,
    runId: args.runId,
    updatedAt: now,
  };
  if (args.appliedLabelId !== undefined) {
    baseSet.appliedLabelId = args.appliedLabelId;
  }

  const result = await db()
    .insert(emailTriage)
    .values({
      documentId: args.documentId,
      userId: args.userId,
      category: args.category,
      confidence: args.confidence,
      rationale: args.rationale,
      model: args.model,
      classifiedAt: now,
      runId: args.runId,
      appliedLabelId: args.appliedLabelId ?? null,
    })
    .onConflictDoUpdate({
      target: emailTriage.documentId,
      set: baseSet,
    })
    .returning();
  const row = result[0];
  if (!row) throw new Error(`[triage] upsert returned no row for doc=${args.documentId}`);
  return {
    documentId: row.documentId,
    userId: row.userId,
    category: row.category as TriageCategory,
    confidence: row.confidence,
    rationale: row.rationale,
    model: row.model,
    appliedLabelId: row.appliedLabelId,
    classifiedAt: row.classifiedAt,
    runId: row.runId,
  };
}

/**
 * Update only the `applied_label_id` on an existing row — used by the
 * label-write step after Gmail's `messages.modify` succeeds.
 */
export async function setAppliedLabelId(documentId: string, appliedLabelId: string): Promise<void> {
  await db()
    .update(emailTriage)
    .set({ appliedLabelId, updatedAt: new Date() })
    .where(eq(emailTriage.documentId, documentId));
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
    .select({ id: integrationCredentials.id })
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
  };
}

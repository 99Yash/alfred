import { db, type DbTransaction } from "@alfred/db";
import {
  agentDecisionTraces,
  agentRuns,
  documents,
  emailTriage,
  integrationCredentials,
  user,
  type EmailTriage,
} from "@alfred/db/schemas";
import {
  documentAskProposalSchema,
  parseGmailDocumentMetadata,
  sanitizeToolResult,
} from "@alfred/contracts";
import type {
  AccountPersona,
  DocumentAskProposal,
  GmailDocumentMetadata,
  SignificanceBand,
  TriageCategory,
  TriageTodoDecision,
  TriageTodoSuggestion,
} from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { normalizeDecisionTraceKey } from "@alfred/assistant/execution";
import type { SenderExtractionEvent } from "./sender-extraction-event";

/** DB access for `email_triage`: one row per (user, thread). User overrides stay pinned. */

/**
 * Per-thread lock key. "One alfred label per thread" lives in Gmail, so no
 * constraint can hold it; concurrent runs would each leave a label.
 */
export function triageThreadLockKey(userId: string, sourceThreadId: string): string {
  return `triage:thread:${userId}:${sourceThreadId}`;
}

/**
 * Run `fn` under the per-thread `pg_advisory_xact_lock`. Callers doing Gmail IO
 * may ignore `tx`; the transaction then only holds the lock.
 */
export async function withTriageThreadLock<T>(
  userId: string,
  sourceThreadId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const key = triageThreadLockKey(userId, sourceThreadId);

  return db().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);

    return fn(tx);
  });
}

/** `category` narrowed to the triage enum; lifecycle dates dropped. */
export type TriageRow = Omit<EmailTriage, "category" | "createdAt" | "updatedAt"> & {
  category: TriageCategory;
};

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
  /** The proposal only, never the ask lifecycle. */
  documentAsk?: DocumentAskProposal | null;
  model: string;
  runId: string | null;
  appliedLabelId?: string | null;
  /** So a same-run retry can re-mint the todo (#157). */
  todoSuggestion?: TriageTodoSuggestion | null;
  todoDecision?: TriageTodoDecision | null;
  /** For the rail's in-category demotion (ADR-0064). */
  senderSignificanceBand?: SignificanceBand | null;
  /** So the reuse path can re-apply the cold-sender gate (#517). */
  senderRelationshipIsCold?: boolean | null;
  /** Written in the same transaction, so a tag never lacks its trace. */
  decisionTrace?:
    | {
        stepId: string;
        attempt: number;
        kind: "triage.classification";
        decisionKey?: string | undefined;
        trace: SenderExtractionEvent;
      }
    | undefined;
  /**
   * Recency guard: an older message must not overwrite a newer one. The backstop
   * for first-touch races, where `appliedLabelId` is still null.
   */
  authoredAt: Date | null;
}

export interface UpsertTriageResult {
  row: TriageRow;
  /** False when a newer stored row won. Gate side effects on it. */
  written: boolean;
}

/**
 * Upsert under the thread lock. A user-pinned row or an older message is a no-op
 * (`written: false`). `appliedLabelId` resets to null unless given, so it only
 * marks the current row as reconciled.
 */
export async function upsertTriage(args: UpsertTriageArgs): Promise<UpsertTriageResult> {
  const documentAsk = args.documentAsk ? documentAskProposalSchema.parse(args.documentAsk) : null;

  return withTriageThreadLock(args.userId, args.sourceThreadId, async (tx) => {
    const existingRows = await tx
      .select()
      .from(emailTriage)
      .where(
        and(
          eq(emailTriage.userId, args.userId),
          eq(emailTriage.sourceThreadId, args.sourceThreadId),
        ),
      )
      .limit(1);

    const existing = existingRows[0];

    // User overrides are sticky; apply-label converges Gmail to the pinned tag.
    if (existing?.source === "user") {
      return { row: rowToTriage(existing), written: false };
    }

    // Keep a strictly newer message's row. Equal timestamps: last writer wins.
    if (args.authoredAt) {
      const existingDocId = existing?.documentId;

      if (existingDocId && existingDocId !== args.documentId) {
        const priorRows = await tx
          .select({ authoredAt: documents.authoredAt })
          .from(documents)
          .where(
            and(
              eq(documents.id, existingDocId),
              eq(documents.userId, args.userId),
              eq(documents.source, "gmail"),
            ),
          );

        const priorAuthoredAt = priorRows[0]?.authoredAt ?? null;

        if (priorAuthoredAt && priorAuthoredAt.getTime() > args.authoredAt.getTime()) {
          return { row: rowToTriage(existing), written: false };
        }
      }
    }

    const now = new Date();

    const updateSet: PgUpdateSetSource<typeof emailTriage> = {
      category: args.category,
      confidence: args.confidence,
      rationale: args.rationale,
      documentAsk,
      model: args.model,
      documentId: args.documentId,
      classifiedAt: now,
      runId: args.runId,
      source: "auto",
      overriddenAt: null,
      appliedLabelId: args.appliedLabelId ?? null,
      todoSuggestion: args.todoSuggestion ?? null,
      todoDecision: args.todoDecision ?? null,
      senderSignificanceBand: args.senderSignificanceBand ?? null,
      senderRelationshipIsCold: args.senderRelationshipIsCold ?? null,
      rowVersion: sql`${emailTriage.rowVersion} + 1`,
      updatedAt: now,
    };

    const result = await tx
      .insert(emailTriage)
      .values({
        userId: args.userId,
        sourceThreadId: args.sourceThreadId,
        documentId: args.documentId,
        category: args.category,
        confidence: args.confidence,
        rationale: args.rationale,
        documentAsk,
        model: args.model,
        classifiedAt: now,
        runId: args.runId,
        appliedLabelId: args.appliedLabelId ?? null,
        todoSuggestion: args.todoSuggestion ?? null,
        todoDecision: args.todoDecision ?? null,
        senderSignificanceBand: args.senderSignificanceBand ?? null,
        senderRelationshipIsCold: args.senderRelationshipIsCold ?? null,
        source: "auto",
        overriddenAt: null,
        rowVersion: 0,
      })
      .onConflictDoUpdate({
        target: [emailTriage.userId, emailTriage.sourceThreadId],
        set: updateSet,
        setWhere: sql`${emailTriage.source} <> 'user'`,
      })
      .returning();

    const row = result[0];

    if (!row) {
      const storedRows = await tx
        .select()
        .from(emailTriage)
        .where(
          and(
            eq(emailTriage.userId, args.userId),
            eq(emailTriage.sourceThreadId, args.sourceThreadId),
          ),
        )
        .limit(1);

      const stored = storedRows[0] ? rowToTriage(storedRows[0]) : null;

      if (stored) return { row: stored, written: false };
      throw new Error(
        `[triage] upsert skipped but no stored row for user=${args.userId} thread=${args.sourceThreadId}`,
      );
    }

    if (args.decisionTrace) {
      if (!args.runId) {
        throw new Error("[triage] decision trace requires a run id");
      }

      const runRows = await tx
        .select({
          userId: agentRuns.userId,
          workflowSlug: agentRuns.workflowSlug,
          currentStep: agentRuns.currentStep,
          attempt: agentRuns.attempt,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, args.runId))
        .limit(1);

      const run = runRows[0];

      if (!run) {
        throw new Error(`[triage] decision trace run not found: ${args.runId}`);
      }

      if (
        run.userId !== args.userId ||
        run.currentStep !== args.decisionTrace.stepId ||
        run.attempt !== args.decisionTrace.attempt
      ) {
        throw new Error(
          `[triage] decision trace run mismatch for run=${args.runId} user=${args.userId}`,
        );
      }

      await tx
        .insert(agentDecisionTraces)
        .values({
          runId: args.runId,
          userId: run.userId,
          workflowSlug: run.workflowSlug,
          stepId: args.decisionTrace.stepId,
          attempt: args.decisionTrace.attempt,
          kind: args.decisionTrace.kind,
          decisionKey: normalizeDecisionTraceKey(args.decisionTrace.decisionKey),
          trace: sanitizeToolResult(args.decisionTrace.trace).value,
        })
        .onConflictDoNothing();
    }

    return { row: rowToTriage(row), written: true };
  });
}

export async function setAppliedLabelId(
  userId: string,
  sourceThreadId: string,
  appliedLabelId: string,
): Promise<void> {
  await db()
    .update(emailTriage)
    .set({
      appliedLabelId,
      rowVersion: sql`${emailTriage.rowVersion} + 1`,
    })
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));
}

/** Repoint the row at the message actually labelled, after a stale-id 404 (#277). */
export async function setTriageReconciledTarget(
  userId: string,
  sourceThreadId: string,
  documentId: string,
  appliedLabelId: string,
): Promise<void> {
  await db()
    .update(emailTriage)
    .set({
      documentId,
      appliedLabelId,
      rowVersion: sql`${emailTriage.rowVersion} + 1`,
    })
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));
}

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
    accountId: string;
    title: string | null;
    content: string;
    authoredAt: Date | null;
    metadata: GmailDocumentMetadata;
  };
  credentialId: string;
  /** Null for credentials connected before persona detection. */
  persona: AccountPersona | null;
  /**
   * For the ownership gate (rule 16a). `email` is a hint that falls back to the
   * primary app email. `mailboxAddress` is authoritative; null means unknown.
   */
  identity: { name: string | null; email: string | null; mailboxAddress: string | null };
}

/** Null when the doc is gone. Throws when it is not Gmail or has no credential. */
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

  const [credRows, userRows] = await Promise.all([
    db()
      .select({
        id: integrationCredentials.id,
        persona: integrationCredentials.persona,
        accountLabel: integrationCredentials.accountLabel,
      })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.userId, userId),
          eq(integrationCredentials.provider, "google"),
          eq(integrationCredentials.accountId, doc.accountId),
        ),
      ),
    db().select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId)),
  ]);

  const cred = credRows[0];

  if (!cred) {
    throw new Error(`[triage] no google credential for user=${userId} account=${doc.accountId}`);
  }

  const userRow = userRows[0];

  return {
    document: {
      id: doc.id,
      userId: doc.userId,
      sourceId: doc.sourceId,
      sourceThreadId: doc.sourceThreadId,
      accountId: doc.accountId,
      title: doc.title,
      content: doc.content,
      authoredAt: doc.authoredAt,
      metadata: parseGmailDocumentMetadata(doc.metadata),
    },
    credentialId: cred.id,
    persona: cred.persona ?? null,
    identity: {
      name: userRow?.name ?? null,
      email: cred.accountLabel ?? userRow?.email ?? null,
      mailboxAddress: cred.accountLabel ?? null,
    },
  };
}

export async function markGmailDocumentSent(args: {
  userId: string;
  documentId: string;
  liveLabelIds: readonly string[];
}): Promise<void> {
  const labelIds = Array.from(new Set([...args.liveLabelIds, "SENT"]));
  await db()
    .update(documents)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(coalesce(${documents.metadata}, '{}'::jsonb), '{isSent}', 'true'::jsonb, true),
        '{labelIds}',
        ${JSON.stringify(labelIds)}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(documents.id, args.documentId),
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
      ),
    );
}

function rowToTriage(row: EmailTriage): TriageRow {
  const documentAsk = documentAskProposalSchema.safeParse(row.documentAsk);

  return {
    userId: row.userId,
    sourceThreadId: row.sourceThreadId,
    documentId: row.documentId,
    category: row.category,
    confidence: row.confidence,
    rationale: row.rationale,
    documentAsk: documentAsk.success ? documentAsk.data : null,
    model: row.model,
    appliedLabelId: row.appliedLabelId,
    classifiedAt: row.classifiedAt,
    runId: row.runId,
    todoSuggestion: row.todoSuggestion ?? null,
    todoDecision: row.todoDecision ?? null,
    senderSignificanceBand: row.senderSignificanceBand,
    senderRelationshipIsCold: row.senderRelationshipIsCold,
    source: row.source,
    overriddenAt: row.overriddenAt,
    rowVersion: row.rowVersion,
  };
}

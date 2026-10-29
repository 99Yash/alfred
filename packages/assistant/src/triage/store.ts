import { db, type DbTransaction } from "@alfred/db";
import {
  agentDecisionTraces,
  agentRuns,
  documents,
  emailTriage,
  emailTriageChanges,
  integrationCredentials,
  standingInstructionSetRevisions,
  type EmailTriage,
} from "@alfred/db/schemas";
import {
  documentAskProposalSchema,
  parseGmailDocumentMetadata,
  sanitizeToolResult,
  triageInstructionEvaluationSchema,
  triageModelVerdictSchema,
} from "@alfred/contracts";
import type {
  AccountPersona,
  DocumentAskProposal,
  GmailDocumentMetadata,
  SignificanceBand,
  TriageCategory,
  TriageInstructionEvaluation,
  TriageModelVerdict,
  TriageTodoDecision,
  TriageTodoSuggestion,
} from "@alfred/contracts";
import { and, eq, ne, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { normalizeDecisionTraceKey } from "@alfred/assistant/execution";
import { userIdentity } from "@alfred/assistant/settings";
import type { StandingFloorAudit } from "./floors";
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

/**
 * `category` narrowed to the triage enum, the two ADR-0113 columns parsed, and lifecycle
 * dates dropped. A column that fails its parse reads as null: no verdict, or no evaluation.
 */
export type TriageRow = Omit<
  EmailTriage,
  "category" | "modelVerdict" | "instructionEvaluation" | "createdAt" | "updatedAt"
> & {
  category: TriageCategory;
  modelVerdict: TriageModelVerdict | null;
  instructionEvaluation: TriageInstructionEvaluation | null;
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
  /** The verdict before any instruction effect (ADR-0113). Null on the fallback path. */
  modelVerdict: TriageModelVerdict | null;
  /** The scoped match results for `documentId`. Null means every scoped instruction is unknown. */
  instructionEvaluation: TriageInstructionEvaluation | null;
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

/** `written` is false when a newer stored row won. Gate side effects on it. */
export type UpsertTriageResult =
  | { row: TriageRow; written: false }
  | {
      row: TriageRow;
      written: true;
      /**
       * The instruction set changed after the classify call read it, so this row can miss a
       * new instruction. The caller enqueues a re-match (ADR-0113, "Writes are conditional").
       */
      instructionSetMoved: boolean;
    };

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
      modelVerdict: args.modelVerdict,
      instructionEvaluation: args.instructionEvaluation,
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
        modelVerdict: args.modelVerdict,
        instructionEvaluation: args.instructionEvaluation,
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

    const [set] = await tx
      .select({ revision: standingInstructionSetRevisions.revision })
      .from(standingInstructionSetRevisions)
      .where(eq(standingInstructionSetRevisions.userId, args.userId));

    const instructionSetMoved =
      (set?.revision ?? 0) > (args.instructionEvaluation?.setRevision ?? 0);

    return { row: rowToTriage(row), written: true, instructionSetMoved };
  });
}

/** A new instruction evaluation and the cached effective result derived with it. */
export type TriageEvaluationUpdate = Pick<
  TriageRow,
  "instructionEvaluation" | "category" | "documentAsk" | "todoSuggestion" | "todoDecision"
>;

/** One re-match change and the evidence for it, which goes to `email_triage_changes`. */
export interface TriageEvaluationChange {
  update: TriageEvaluationUpdate;
  /** The instruction-set revision that the job read. */
  setRevision: number;
  /** The instruction floor's audit, or null when the row has no model verdict. */
  floor: StandingFloorAudit | null;
}

/**
 * The conditional write of the re-match job (ADR-0113, "Writes are conditional"). Under the
 * thread lock and a row lock, `next` reads the row again and returns the change, or null for
 * no change. A missing row, a user-pinned row, or a row that moved to another document is not
 * written. The row lock matters: the user override does not take the thread lock, so without
 * it an override that commits during the read is overwritten (invariant 5 of
 * `docs/rfc-triage-tags.md`). The UPDATE repeats the guards for the same reason.
 * A changed category clears `appliedLabelId`, so the label reads as behind the category.
 * The change and its evidence go to `email_triage_changes` in the same transaction.
 */
export async function updateTriageEvaluation(args: {
  userId: string;
  sourceThreadId: string;
  documentId: string;
  next: (row: TriageRow) => TriageEvaluationChange | null;
}): Promise<{ previous: TriageRow; update: TriageEvaluationUpdate } | null> {
  return withTriageThreadLock(args.userId, args.sourceThreadId, async (tx) => {
    const rowIs = and(
      eq(emailTriage.userId, args.userId),
      eq(emailTriage.sourceThreadId, args.sourceThreadId),
    );

    const [stored] = await tx.select().from(emailTriage).where(rowIs).limit(1).for("update");

    if (!stored || stored.source === "user" || stored.documentId !== args.documentId) return null;

    const previous = rowToTriage(stored);
    const change = args.next(previous);

    if (change === null) return null;

    const { update } = change;

    const written = await tx
      .update(emailTriage)
      .set({
        ...update,
        ...(update.category !== previous.category ? { appliedLabelId: null } : {}),
        rowVersion: sql`${emailTriage.rowVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(rowIs, ne(emailTriage.source, "user"), eq(emailTriage.documentId, args.documentId)),
      )
      .returning({ sourceThreadId: emailTriage.sourceThreadId });

    if (written.length === 0) return null;

    await tx.insert(emailTriageChanges).values({
      userId: args.userId,
      sourceThreadId: args.sourceThreadId,
      documentId: args.documentId,
      setRevision: change.setRevision,
      previous: {
        category: previous.category,
        documentAsk: previous.documentAsk,
        todoSuggestion: previous.todoSuggestion,
        todoDecision: previous.todoDecision,
      },
      next: {
        category: update.category,
        documentAsk: update.documentAsk,
        todoSuggestion: update.todoSuggestion,
        todoDecision: update.todoDecision,
      },
      scopes: update.instructionEvaluation?.scopes ?? [],
      floor: change.floor,
    });

    return { previous, update };
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

  const [credRows, identity] = await Promise.all([
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
    userIdentity({ userId }),
  ]);

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
      accountId: doc.accountId,
      title: doc.title,
      content: doc.content,
      authoredAt: doc.authoredAt,
      metadata: parseGmailDocumentMetadata(doc.metadata),
    },
    credentialId: cred.id,
    persona: cred.persona ?? null,
    identity: {
      name: identity.name,
      email: cred.accountLabel ?? identity.primaryEmail,
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

/**
 * Parse the two ADR-0113 columns. A column that fails its parse reads as null: no verdict, or
 * no evaluation, so every scoped instruction is `unknown`.
 */
export function parseTriageEvaluationColumns(
  row: Pick<EmailTriage, "modelVerdict" | "instructionEvaluation">,
): Pick<TriageRow, "modelVerdict" | "instructionEvaluation"> {
  const modelVerdict = triageModelVerdictSchema.safeParse(row.modelVerdict);

  const instructionEvaluation = triageInstructionEvaluationSchema.safeParse(
    row.instructionEvaluation,
  );

  return {
    modelVerdict: modelVerdict.success ? modelVerdict.data : null,
    instructionEvaluation: instructionEvaluation.success ? instructionEvaluation.data : null,
  };
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
    ...parseTriageEvaluationColumns(row),
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

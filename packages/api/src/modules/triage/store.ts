import { db } from "@alfred/db";
import {
  agentDecisionTraces,
  agentRuns,
  documents,
  emailTriage,
  integrationCredentials,
  user,
  type EmailTriage,
} from "@alfred/db/schemas";
import { sanitizeToolResult, toRecord } from "@alfred/contracts";
import type {
  AccountPersona,
  SignificanceBand,
  TriageCategory,
  TriageTodoDecision,
  TriageTodoSuggestion,
} from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { normalizeDecisionTraceKey } from "../agent/decision-traces";
import type { SenderExtractionEvent } from "./sender-extraction-event";

type TriageDbRoot = ReturnType<typeof db>;
type TriageDbTransaction = Parameters<Parameters<TriageDbRoot["transaction"]>[0]>[0];

/**
 * Persistence helpers for the thread-keyed triage table. The workflow owns
 * the LLM call and the Gmail label-write; this module is pure DB access.
 * One row per (userId, sourceThreadId) — classifier-authored rows update on
 * newer messages, while user-authored overrides stay pinned until the user
 * changes them again.
 */

/**
 * Advisory-lock key for serializing all triage work on a single Gmail thread.
 *
 * Why a lock and not a constraint (ADR-0025 follow-up): the invariant we need
 * — "a thread shows at most one alfred label" — lives in *Gmail*, an external
 * system, not in our tables. No Postgres constraint can reach it. When several
 * messages of one thread are ingested together (backfill, a pub/sub batch),
 * each fresh document fans out its own triage run; without serialization the
 * runs interleave their Gmail read→apply→strip and each leaves its own label,
 * so the thread view unions two+ tags. We use Postgres purely as the cross-run
 * mutex (same pattern as `replicache/pull` and `todos/suggest`): hold the lock
 * across the classify row-write and the label-write so they converge to a
 * single tag on the thread's canonical (most-recently-classified) message.
 */
export function triageThreadLockKey(userId: string, sourceThreadId: string): string {
  return `triage:thread:${userId}:${sourceThreadId}`;
}

/**
 * Run `fn` while holding the per-thread advisory lock. Transaction-scoped
 * (`pg_advisory_xact_lock`), released on commit/rollback — concurrent runs for
 * the same thread block here and execute one at a time. DB-only callers can use
 * the transaction handle to make their writes atomic with each other; callers
 * that also do Gmail IO may ignore the handle and keep their existing pooled DB
 * calls while this transaction only parks the lock. At single-user scale
 * (worker concurrency 4, pool max 10) holding the lock across the handful of
 * Gmail round-trips is well within the connection budget.
 */
export async function withTriageThreadLock<T>(
  userId: string,
  sourceThreadId: string,
  fn: (tx: TriageDbTransaction) => Promise<T>,
): Promise<T> {
  const key = triageThreadLockKey(userId, sourceThreadId);
  return db().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    return fn(tx);
  });
}

/**
 * DB row with `category` narrowed to the triage enum. `source` is already
 * branded on the column (`.$type<TriageTagSource>()`); every other column
 * tracks `EmailTriage` ($inferSelect). The lifecycle dates are dropped
 * deliberately — `rowToTriage` doesn't surface them.
 */
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
  model: string;
  runId: string | null;
  appliedLabelId?: string | null;
  /**
   * Classifier todo proposal + rubric trace (rule 16). Persisted on the row so a
   * same-run `classify` retry on the reuse path can reconstruct the classification
   * and re-mint the todo a crashed first attempt never wrote (#157). Omit/null
   * when the model proposed no todo.
   */
  todoSuggestion?: TriageTodoSuggestion | null;
  todoDecision?: TriageTodoDecision | null;
  /**
   * Sender-significance band at classify time (ADR-0064). Persisted so the rail
   * can demote a low-significance sender's thread within its honest category.
   * Null/omitted when the sender is non-human / unscored / had no graph row.
   */
  senderSignificanceBand?: SignificanceBand | null;
  /**
   * Typed rule-16b cold-contact verdict at classify time (#517). Persisted so a
   * same-run `classify` retry on the reuse path re-applies the cold-sender todo
   * gate from the row instead of re-deriving it from observations it no longer
   * has. Null/omitted when the sender is non-human / unscored / had no graph row.
   */
  senderRelationshipIsCold?: boolean | null;
  /**
   * Durable forensic trace for this classifier decision. Written in the same
   * transaction as the canonical triage row so a worker crash after row write
   * cannot leave a tag without its "why" record.
   */
  decisionTrace?: {
    stepId: string;
    attempt: number;
    kind: "triage.classification";
    decisionKey?: string;
    trace: SenderExtractionEvent;
  };
  /**
   * Authored timestamp of the message this classification is for. Drives the
   * recency guard: a run for an OLDER message in the thread must not clobber a
   * classification already written for a NEWER one. Concurrent first-touch runs
   * (backfill burst) race the row with `appliedLabelId` still null, so the
   * classify-step skip guard can't catch them — this is the backstop that makes
   * the row converge on the newest message regardless of which run writes last.
   */
  authoredAt: Date | null;
}

export interface UpsertTriageResult {
  row: TriageRow;
  /**
   * False when the recency guard kept a strictly-newer stored classification
   * (this run lost the race). Callers gate their best-effort side effects
   * (inbox publish, sender-prior bump, todo suggestion) on this so a superseded
   * older message doesn't emit signals for a tag that isn't canonical.
   */
  written: boolean;
}

/**
 * Insert or update the thread's triage row, holding the per-thread advisory
 * lock so the read-existing → recency-check → write is atomic against other
 * runs on the same thread. Re-classification on a newer message overwrites an
 * `auto` row in place; a user-pinned row, or a run for an older message
 * (different `documentId`, older `authoredAt`), is a no-op and returns the
 * stored row with `written: false`.
 *
 * `appliedLabelId` is set exactly to the caller's value when provided; otherwise
 * an auto rewrite clears it to `null`. The label-write step sets the fresh Gmail
 * id after `reconcileThreadLabel` succeeds. This keeps the column a truthful
 * "current row has been reconciled" marker instead of carrying an old label id
 * across a category/document change.
 */
export async function upsertTriage(args: UpsertTriageArgs): Promise<UpsertTriageResult> {
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

    // User overrides are sticky: the classifier may still run on a new inbound
    // message, but it cannot silently replace the user's chosen category. The
    // apply-label step re-reads this row and converges Gmail to the pinned tag.
    if (existing?.source === "user") {
      return { row: rowToTriage(existing), written: false };
    }

    // Recency guard: if the thread already carries a classification for a
    // DIFFERENT, strictly-newer message, keep it. Equal timestamps fall
    // through to overwrite (last writer wins) — a same-second reply is rare
    // and either category is defensible; the label-write converges anyway.
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
          trace: sanitizeToolResult(args.decisionTrace.trace).value as object,
        })
        .onConflictDoNothing();
    }
    return { row: rowToTriage(row), written: true };
  });
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
    .set({
      appliedLabelId,
      rowVersion: sql`${emailTriage.rowVersion} + 1`,
    })
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, sourceThreadId)));
}

/**
 * Repoint a thread's triage row at the message that was actually labeled and
 * record the applied label in one write. Used by the relabel path when the
 * stored `document_id`'s Gmail message id has gone stale (404) and the label
 * had to be re-resolved to a live message in the thread instead (#277) — both
 * `document_id` and `applied_label_id` must then reflect that live message.
 */
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
    accountId: string;
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
  persona: AccountPersona | null;
  /**
   * Minimal identity of the user whose mailbox this is (ADR-0050/0051 amendment
   * 2026-06-09) — display name + the account email. Feeds the todo
   * ownership-attribution gate so an action the email assigns to a named third
   * party isn't minted as the user's todo. Deliberately just identity.
   */
  identity: { name: string | null; email: string | null };
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

  // Both reads key only off `userId` / `doc.accountId` (already resolved), so
  // run them on one round-trip instead of two — this is the per-classification
  // hot path. The user row feeds the ownership-attribution gate: display name
  // from the user row, account email from the credential's label (the precise
  // per-account address), falling back to the user's primary email. Best-effort.
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
      metadata: toRecord(doc.metadata),
    },
    credentialId: cred.id,
    persona: cred.persona ?? null,
    identity: {
      name: userRow?.name ?? null,
      email: cred.accountLabel ?? userRow?.email ?? null,
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
    todoSuggestion: row.todoSuggestion ?? null,
    todoDecision: row.todoDecision ?? null,
    senderSignificanceBand: row.senderSignificanceBand,
    senderRelationshipIsCold: row.senderRelationshipIsCold,
    source: row.source,
    overriddenAt: row.overriddenAt,
    rowVersion: row.rowVersion,
  };
}

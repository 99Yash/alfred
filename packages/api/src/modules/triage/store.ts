import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import type { AccountPersona, TriageCategory, TriageTagSource } from "@alfred/contracts";
import { and, eq, sql } from "drizzle-orm";

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
 * the same thread block here and execute one at a time. `fn` does its own DB +
 * Gmail IO on the pooled `db()` (a separate connection); the open transaction
 * only parks the lock. At single-user scale (worker concurrency 4, pool max 10)
 * holding the lock across the handful of Gmail round-trips is well within the
 * connection budget.
 */
export async function withTriageThreadLock<T>(
  userId: string,
  sourceThreadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = triageThreadLockKey(userId, sourceThreadId);
  return db().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    return fn();
  });
}

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
  source: TriageTagSource;
  overriddenAt: Date | null;
  rowVersion: number;
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
  return withTriageThreadLock(args.userId, args.sourceThreadId, async () => {
    const existingRows = await db()
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
        const priorAuthoredAt = await getDocumentAuthoredAt(args.userId, existingDocId);
        if (priorAuthoredAt && priorAuthoredAt.getTime() > args.authoredAt.getTime()) {
          return { row: rowToTriage(existing), written: false };
        }
      }
    }

    const now = new Date();
    const updateSet: Record<string, unknown> = {
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
      rowVersion: sql`${emailTriage.rowVersion} + 1`,
      updatedAt: now,
    };

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
      const stored = await getTriage(args.userId, args.sourceThreadId);
      if (stored) return { row: stored, written: false };
      throw new Error(
        `[triage] upsert skipped but no stored row for user=${args.userId} thread=${args.sourceThreadId}`,
      );
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
      updatedAt: new Date(),
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
    source: row.source,
    overriddenAt: row.overriddenAt,
    rowVersion: row.rowVersion,
  };
}

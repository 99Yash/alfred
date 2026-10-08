import { mapConcurrent, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage } from "@alfred/db/schemas";
import { getFreshAccessToken, getThreadMessageLabels } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";
import { gmailSentSql } from "./sent-mail";
import { triageThreadLockKey } from "./store";

export interface ReconcileGmailThreadsArgs {
  credentialId: string;
  userId: string;
  /** Threads with a fresh insert this run. */
  threadIds: string[];
  /** Rows inserted by this job; never delete them in the same pass. */
  protectedDocumentIds?: readonly string[];
}

export interface ReconcileGmailThreadsResult {
  threadsChecked: number;
  threadsReconciled: number;
  docsDeleted: number;
  triageRepointed: number;
  /** Repointed threads that need a relabel. */
  repointedThreadIds: string[];
}

export interface ReconcileStoredGmailDoc {
  id: string;
  sourceId: string;
  authoredAt: Date | null;
  ingestedAt: Date;
  isSent: boolean;
}

export interface GmailThreadReconcilePlan {
  deadDocumentIdsToDelete: string[];
  repointDocumentId: string | null;
}

export interface LiveInboundGmailDocument {
  threadId: string;
  documentId: string;
}

const RECONCILE_CONCURRENCY = 4;

/** Repoint only to a live received doc; sent mail never becomes the labelled doc (ADR-0051 #7). */
export function planGmailThreadReconcile(args: {
  storedDocs: readonly ReconcileStoredGmailDoc[];
  liveSourceIds: ReadonlySet<string>;
  triageDocumentId: string | null;
  liveFetchedAt: Date;
  protectedDocumentIds?: ReadonlySet<string>;
}): GmailThreadReconcilePlan {
  const confirmedDead = args.storedDocs.filter(
    (doc) => !args.liveSourceIds.has(doc.sourceId) && doc.ingestedAt <= args.liveFetchedAt,
  );

  const deadIds = new Set(confirmedDead.map((doc) => doc.id));
  const protectedIds = args.protectedDocumentIds ?? new Set<string>();

  const repointTarget =
    args.storedDocs
      .filter((doc) => args.liveSourceIds.has(doc.sourceId) && !doc.isSent)
      .sort(compareNewestFirst)[0] ?? null;

  let deadToDelete = confirmedDead.filter((doc) => !protectedIds.has(doc.id));
  let repointDocumentId: string | null = null;

  const pointedDoc = args.triageDocumentId
    ? (args.storedDocs.find((doc) => doc.id === args.triageDocumentId) ?? null)
    : null;

  const pointerNeedsRepoint = Boolean(
    args.triageDocumentId && (deadIds.has(args.triageDocumentId) || pointedDoc?.isSent === true),
  );

  if (pointerNeedsRepoint) {
    if (repointTarget) {
      repointDocumentId = repointTarget.id;
    } else if (args.triageDocumentId && deadIds.has(args.triageDocumentId)) {
      // No live inbound: keep the dead pointed row so briefing's inner join resolves.
      deadToDelete = confirmedDead.filter(
        (doc) => doc.id !== args.triageDocumentId && !protectedIds.has(doc.id),
      );
    }
  }

  return {
    deadDocumentIdsToDelete: deadToDelete.map((doc) => doc.id),
    repointDocumentId,
  };
}

/**
 * Converge a thread's `documents` to the live Gmail message set (#279). Gmail
 * reshuffles ids around sends, so a stored id can die and the triage pointer
 * with it (#277). Repoint first, then delete dead rows. Prune only after a
 * non-empty live fetch, and never rows inserted after the fetch began.
 */
export async function reconcileGmailThreads(
  args: ReconcileGmailThreadsArgs,
): Promise<ReconcileGmailThreadsResult> {
  const distinct = Array.from(new Set(args.threadIds.filter(Boolean)));

  const empty: ReconcileGmailThreadsResult = {
    threadsChecked: distinct.length,
    threadsReconciled: 0,
    docsDeleted: 0,
    triageRepointed: 0,
    repointedThreadIds: [],
  };

  if (distinct.length === 0) return empty;

  const cred = await loadGoogleCredentialOrThrow(args.credentialId);

  if (cred.userId !== args.userId) {
    throw new Error(
      `[gmail.reconcile] credential=${args.credentialId} belongs to user=${cred.userId}, not user=${args.userId}`,
    );
  }

  const counts = await db()
    .select({ threadId: documents.sourceThreadId, n: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.userId, args.userId),
        eq(documents.source, "gmail"),
        eq(documents.accountId, cred.accountId),
        inArray(documents.sourceThreadId, distinct),
      ),
    )
    .groupBy(documents.sourceThreadId);

  const multi = counts
    .filter((c) => c.n > 1)
    .map((c) => c.threadId)
    .filter((threadId): threadId is string => Boolean(threadId));

  if (multi.length === 0) return empty;

  const accessToken = await getFreshAccessToken(args.credentialId);
  const protectedDocumentIds = new Set(args.protectedDocumentIds ?? []);
  let threadsReconciled = 0;
  let docsDeleted = 0;
  let triageRepointed = 0;
  const repointedThreadIds: string[] = [];

  await mapConcurrent(multi, RECONCILE_CONCURRENCY, async (threadId) => {
    try {
      const liveFetchedAt = new Date();
      const live = await getThreadMessageLabels({ accessToken, threadId });
      const liveIds = new Set(live.map((message) => message.id));

      if (liveIds.size === 0) return;

      const outcome = await db().transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${triageThreadLockKey(args.userId, threadId)}))`,
        );

        const stored = await tx
          .select({
            id: documents.id,
            sourceId: documents.sourceId,
            authoredAt: documents.authoredAt,
            ingestedAt: documents.ingestedAt,
            isSent: gmailSentSql(),
          })
          .from(documents)
          .where(
            and(
              eq(documents.userId, args.userId),
              eq(documents.source, "gmail"),
              eq(documents.accountId, cred.accountId),
              eq(documents.sourceThreadId, threadId),
            ),
          );

        const triageRow = await tx
          .select({ documentId: emailTriage.documentId })
          .from(emailTriage)
          .where(and(eq(emailTriage.userId, args.userId), eq(emailTriage.sourceThreadId, threadId)))
          .limit(1);

        const pointedDocId = triageRow[0]?.documentId ?? null;

        const plan = planGmailThreadReconcile({
          storedDocs: stored,
          liveSourceIds: liveIds,
          triageDocumentId: pointedDocId,
          liveFetchedAt,
          protectedDocumentIds,
        });

        if (!plan.repointDocumentId && plan.deadDocumentIdsToDelete.length === 0) {
          return { reconciled: false, docsDeleted: 0, repointed: false };
        }

        if (plan.repointDocumentId) {
          await tx
            .update(emailTriage)
            .set({
              documentId: plan.repointDocumentId,
              appliedLabelId: null,
              rowVersion: sql`${emailTriage.rowVersion} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(eq(emailTriage.userId, args.userId), eq(emailTriage.sourceThreadId, threadId)),
            );
        }

        if (plan.deadDocumentIdsToDelete.length > 0) {
          await tx
            .delete(documents)
            .where(
              and(
                eq(documents.userId, args.userId),
                eq(documents.source, "gmail"),
                eq(documents.accountId, cred.accountId),
                inArray(documents.id, plan.deadDocumentIdsToDelete),
              ),
            );
        }

        return {
          reconciled: true,
          docsDeleted: plan.deadDocumentIdsToDelete.length,
          repointed: Boolean(plan.repointDocumentId),
        };
      });

      if (!outcome.reconciled) return;
      docsDeleted += outcome.docsDeleted;

      if (outcome.repointed) {
        triageRepointed++;
        repointedThreadIds.push(threadId);
      }

      threadsReconciled++;
    } catch (err) {
      console.warn(`[gmail.reconcile] thread=${threadId} skipped:`, toMessage(err));
    }
  });

  return {
    threadsChecked: distinct.length,
    threadsReconciled,
    docsDeleted,
    triageRepointed,
    repointedThreadIds,
  };
}

export async function findNewestLiveInboundGmailDocuments(args: {
  credentialId: string;
  userId: string;
  threadIds: string[];
}): Promise<LiveInboundGmailDocument[]> {
  const distinct = Array.from(new Set(args.threadIds.filter(Boolean)));

  if (distinct.length === 0) return [];

  const cred = await loadGoogleCredentialOrThrow(args.credentialId);

  if (cred.userId !== args.userId) {
    throw new Error(
      `[gmail.live-inbound] credential=${args.credentialId} belongs to user=${cred.userId}, not user=${args.userId}`,
    );
  }

  const accessToken = await getFreshAccessToken(args.credentialId);
  const targets: LiveInboundGmailDocument[] = [];
  await mapConcurrent(distinct, RECONCILE_CONCURRENCY, async (threadId) => {
    try {
      const live = await getThreadMessageLabels({ accessToken, threadId });
      const liveIds = live.map((message) => message.id);

      if (liveIds.length === 0) return;

      const rows = await db()
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.userId, args.userId),
            eq(documents.source, "gmail"),
            eq(documents.accountId, cred.accountId),
            eq(documents.sourceThreadId, threadId),
            inArray(documents.sourceId, liveIds),
            sql`NOT (${gmailSentSql()})`,
          ),
        )
        .orderBy(sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`)
        .limit(1);

      const documentId = rows[0]?.id;

      if (documentId) targets.push({ threadId, documentId });
    } catch (err) {
      console.warn(`[gmail.live-inbound] thread=${threadId} skipped:`, toMessage(err));
    }
  });

  return targets;
}

function compareNewestFirst(a: ReconcileStoredGmailDoc, b: ReconcileStoredGmailDoc): number {
  const timeDiff =
    (b.authoredAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (a.authoredAt?.getTime() ?? Number.NEGATIVE_INFINITY);

  if (timeDiff !== 0) return timeDiff;

  return b.id.localeCompare(a.id);
}

async function loadGoogleCredentialOrThrow(
  credentialId: string,
): Promise<{ id: string; userId: string; accountId: string }> {
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

  if (!row) throw new Error(`[gmail.reconcile] credential not found: ${credentialId}`);

  if (row.provider !== "google") {
    throw new Error(`[gmail.reconcile] credential provider must be google, got ${row.provider}`);
  }

  return { id: row.id, userId: row.userId, accountId: row.accountId };
}

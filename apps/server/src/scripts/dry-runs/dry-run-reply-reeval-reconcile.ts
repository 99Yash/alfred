/**
 * Dry-run replay for #282 (reply re-eval) + #279 (thread reconcile) — READ-ONLY.
 *
 * Simulates exactly what the two new code paths would do, against the live dev
 * DB + live Gmail, but MUTATES NOTHING: it never refreshes credentials, never
 * emits a triage event, never repoints `email_triage.document_id`, never deletes
 * a `documents` row. It only fetches live Gmail thread message lists (read) to
 * compute what reconcile would prune.
 *
 * #282 — for each thread that has BOTH a sent doc and a triage row, report the
 *        newest INBOUND doc the reply-re-eval would re-key the classify on, and
 *        the thread's current frozen tag.
 * #279 — for each multi-doc thread, fetch the live Gmail message set and report
 *        the dead-id tail reconcile would repoint-then-delete.
 *
 * Run:  pnpm --filter server exec tsx --env-file=.env \
 *         src/scripts/dry-runs/dry-run-reply-reeval-reconcile.ts [threadId ...]
 *
 * With no args it auto-scans a bounded sample; pass explicit thread ids to
 * target known cases (e.g. 19ef44b6b5a0183b — the #282 Tania thread).
 */
import { isSentGmailMetadata } from "@alfred/api/modules/triage/sent-mail";
import {
  planGmailThreadReconcile,
  type ReconcileStoredGmailDoc,
} from "@alfred/api/modules/triage/gmail-reconcile";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import { getThreadMessageLabels } from "@alfred/integrations/google";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

const SCAN_LIMIT_282 = 8;
const SCAN_LIMIT_279 = 15;
const TOKEN_EXPIRY_SAFETY_MS = 60_000;

type DocRow = {
  id: string;
  sourceId: string;
  authoredAt: Date | null;
  ingestedAt: Date;
  accountId: string | null;
  metadata: Record<string, unknown>;
};

type GoogleCredentialSnapshot = Pick<
  typeof integrationCredentials.$inferSelect,
  "id" | "userId" | "accountId" | "accessToken" | "expiresAt" | "status"
>;

async function loadThreadDocs(userId: string, threadId: string): Promise<DocRow[]> {
  return (await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      authoredAt: documents.authoredAt,
      ingestedAt: documents.ingestedAt,
      accountId: documents.accountId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        eq(documents.sourceThreadId, threadId),
      ),
    )
    .orderBy(desc(documents.authoredAt))) as DocRow[];
}

function newestInbound(docs: DocRow[]): DocRow | null {
  // docs already sorted newest-first; first non-sent wins (mirrors the
  // `NOT(gmailSentSql()) ORDER BY authoredAt DESC LIMIT 1` query in queue.ts).
  return docs.find((d) => !isSentGmailMetadata(d.metadata)) ?? null;
}

async function main() {
  const argThreads = process.argv.slice(2).filter(Boolean);

  // Single-user app, but be correct: resolve a user + a per-account token map.
  const creds = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
      accessToken: integrationCredentials.accessToken,
      expiresAt: integrationCredentials.expiresAt,
      status: integrationCredentials.status,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "google"));
  if (creds.length === 0) {
    console.log("no google credentials in this DB — nothing to replay");
    return;
  }
  const firstCred = creds[0]!;
  const userId = firstCred.userId;
  const credByAccount = new Map(creds.map((c) => [c.accountId, c.id]));
  const credById = new Map(creds.map((c) => [c.id, c]));
  const tokenCache = new Map<string, string>();
  async function tokenForAccount(accountId: string | null): Promise<string | null> {
    const credId = (accountId && credByAccount.get(accountId)) ?? firstCred.id;
    if (tokenCache.has(credId)) return tokenCache.get(credId)!;
    const cred = credById.get(credId);
    if (!cred) return null;
    const token = readOnlyUsableToken(cred);
    if (!token) {
      console.warn(`  stored token unavailable/expired for cred=${credId}; skipping live fetch`);
      return null;
    }
    tokenCache.set(credId, token);
    return token;
  }

  // ---- #282: reply re-eval candidates -------------------------------------
  console.log("══════════════════════════════════════════════════════════");
  console.log("#282 — outbound-reply re-eval (READ-ONLY simulation)");
  console.log("══════════════════════════════════════════════════════════");

  // Threads that have at least one SENT doc AND a triage row.
  const sentThreadRows = await db()
    .select({ threadId: documents.sourceThreadId })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        sql`COALESCE((${documents.metadata} ->> 'isSent')::boolean, false)
          OR COALESCE(${documents.metadata} -> 'labelIds', '[]'::jsonb) ? 'SENT'`,
      ),
    )
    .groupBy(documents.sourceThreadId);
  const sentThreadIds = sentThreadRows
    .map((r) => r.threadId)
    .filter((t): t is string => Boolean(t));

  const triagedRows = sentThreadIds.length
    ? await db()
        .select({
          threadId: emailTriage.sourceThreadId,
          category: emailTriage.category,
          documentId: emailTriage.documentId,
          classifiedAt: emailTriage.classifiedAt,
        })
        .from(emailTriage)
        .where(
          and(eq(emailTriage.userId, userId), inArray(emailTriage.sourceThreadId, sentThreadIds)),
        )
    : [];
  const triagedByThread = new Map(triagedRows.map((r) => [r.threadId, r]));

  const candidates282 = (
    argThreads.length ? argThreads : sentThreadIds.filter((t) => triagedByThread.has(t))
  ).slice(0, argThreads.length ? undefined : SCAN_LIMIT_282);

  if (candidates282.length === 0) {
    console.log("(no threads with both a sent doc and a triage row)\n");
  }
  for (const threadId of candidates282) {
    const tr = triagedByThread.get(threadId);
    const docs = await loadThreadDocs(userId, threadId);
    const sent = docs.filter((d) => isSentGmailMetadata(d.metadata));
    const inbound = newestInbound(docs);
    console.log(`\nthread=${threadId}`);
    console.log(
      `  current tag: ${tr?.category ?? "(no triage row)"} ` +
        `| classified_at=${tr?.classifiedAt?.toISOString() ?? "?"} ` +
        `| points_at_doc=${tr?.documentId ?? "?"}`,
    );
    console.log(`  docs=${docs.length} sent=${sent.length} inbound=${docs.length - sent.length}`);
    if (!tr) {
      console.log("  → SKIP: no triage row (brand-new outbound-first thread)");
      continue;
    }
    if (!inbound) {
      console.log("  → SKIP: no inbound doc to key the received-only classify on");
      continue;
    }
    const pointsAtSent = tr.documentId
      ? Boolean(docs.find((d) => d.id === tr.documentId && isSentGmailMetadata(d.metadata)))
      : false;
    console.log(
      `  → WOULD emit message_received(eventId=${inbound.id}, reason="reply", force=true)`,
    );
    console.log(
      `     re-keys on newest inbound (authored ${inbound.authoredAt?.toISOString() ?? "?"}); ` +
        `classify stays received-only, getThreadState folds the reply`,
    );
    if (pointsAtSent) {
      console.log("     NOTE: triage row currently points at a SENT doc (should never happen)");
    }
  }

  // ---- #279: thread reconcile candidates ----------------------------------
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("#279 — thread reconcile vs live Gmail (READ-ONLY simulation)");
  console.log("══════════════════════════════════════════════════════════");

  // Multi-doc threads (only these can carry a dead tail worth converging).
  const multiRows = await db()
    .select({ threadId: documents.sourceThreadId, n: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")))
    .groupBy(documents.sourceThreadId)
    .having(sql`count(*) > 1`)
    .orderBy(sql`count(*) desc`);
  const multiThreadIds = multiRows.map((r) => r.threadId).filter((t): t is string => Boolean(t));

  const candidates279 = argThreads.length ? argThreads : multiThreadIds.slice(0, SCAN_LIMIT_279);

  let totalDead = 0;
  let threadsWithDead = 0;
  for (const threadId of candidates279) {
    const docs = await loadThreadDocs(userId, threadId);
    if (docs.length <= 1) continue;
    const token = await tokenForAccount(docs[0]!.accountId);
    if (!token) {
      console.log(`\nthread=${threadId}  → SKIP: no token`);
      continue;
    }
    let liveIds: Set<string>;
    const liveFetchedAt = new Date();
    try {
      const live = await getThreadMessageLabels({ accessToken: token, threadId });
      liveIds = new Set(live.map((m) => m.id));
    } catch (err) {
      console.log(`\nthread=${threadId}  → SKIP (live fetch failed): ${toMessage(err)}`);
      continue;
    }
    if (liveIds.size === 0) {
      console.log(`\nthread=${threadId}  → SKIP: live fetch returned 0 messages`);
      continue;
    }
    const dead = docs.filter((d) => !liveIds.has(d.sourceId));
    if (dead.length === 0) continue; // healthy thread — stay quiet

    threadsWithDead++;
    totalDead += dead.length;
    const tr = await db()
      .select({ documentId: emailTriage.documentId })
      .from(emailTriage)
      .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, threadId)))
      .limit(1);
    const pointedDocId = tr[0]?.documentId ?? null;
    const pointedIsDead = pointedDocId ? dead.some((d) => d.id === pointedDocId) : false;
    const pointedIsSent = pointedDocId
      ? Boolean(docs.find((d) => d.id === pointedDocId && isSentGmailMetadata(d.metadata)))
      : false;
    const plan = planGmailThreadReconcile({
      storedDocs: docs.map(toStoredDoc),
      liveSourceIds: liveIds,
      triageDocumentId: pointedDocId,
      liveFetchedAt,
    });

    console.log(`\nthread=${threadId}`);
    console.log(
      `  stored=${docs.length} live=${liveIds.size} DEAD=${dead.length} ` +
        `(stored ids that 404 in the live thread)`,
    );
    if (pointedIsDead || pointedIsSent) {
      if (plan.repointDocumentId) {
        console.log(
          `  → WOULD repoint email_triage.document_id ${pointedDocId} → ${plan.repointDocumentId} (newest live inbound)`,
        );
        console.log(`  → WOULD delete ${plan.deadDocumentIdsToDelete.length} dead docs`);
      } else {
        console.log(
          `  → triage points at ${pointedIsSent ? "a SENT" : "a dead"} doc but NO live inbound ` +
            `doc to repoint to — delete ${plan.deadDocumentIdsToDelete.length} others`,
        );
      }
    } else {
      console.log(
        `  → triage pointer is live inbound/none — WOULD delete ` +
          `${plan.deadDocumentIdsToDelete.length} dead docs`,
      );
    }
  }
  if (threadsWithDead === 0) {
    console.log(`\n(scanned ${candidates279.length} threads — no dead-id tails found)`);
  } else {
    console.log(
      `\n# Reconcile would touch ${threadsWithDead} thread(s), prune ${totalDead} dead doc(s)`,
    );
  }
}

function readOnlyUsableToken(cred: GoogleCredentialSnapshot): string | null {
  if (cred.status !== "active") return null;
  if (!cred.accessToken) return null;
  if (!cred.expiresAt) return null;
  if (cred.expiresAt.getTime() - Date.now() < TOKEN_EXPIRY_SAFETY_MS) return null;
  return cred.accessToken;
}

function toStoredDoc(doc: DocRow): ReconcileStoredGmailDoc {
  return {
    id: doc.id,
    sourceId: doc.sourceId,
    authoredAt: doc.authoredAt,
    ingestedAt: doc.ingestedAt,
    isSent: isSentGmailMetadata(doc.metadata),
  };
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(toMessage(e));
    process.exit(1);
  });

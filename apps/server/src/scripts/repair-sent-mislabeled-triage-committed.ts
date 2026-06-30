/**
 * COMMITTED legacy repair: triage rows that point at (and labeled) the user's
 * own SENT message — ADR-0051 #7 violation (issue #306, Direction #2).
 *
 * Symptom (dev DB, 2026-06-26): some `email_triage` rows have `document_id`
 * pointing at a doc that is `From: <the user>` carrying the Gmail `SENT` label,
 * and an Alfred category label was written back onto that sent message. These
 * are legacy rows: they were ingested/classified BEFORE ADR-0051 #7's sent
 * exclusion fully landed (a doc whose `SENT` label wasn't yet attached at ingest
 * slipped the fan-out filter, got classified, and was pointed + labeled).
 *
 * Direction #1 (the use-time classify guard) shipped in PR #305 and stops all
 * NEW mis-pointings. This script repairs the rows already on file:
 *
 *   Case A — the thread has a live inbound doc:
 *     • under the triage thread lock, re-read the row to prove it still points at
 *       the same sent doc; strip Alfred labels off that sent message first; apply
 *       the row's category to the newest inbound doc; then repoint
 *       `email_triage.document_id` and persist the applied label id.
 *
 *   Case B — the thread has NO inbound doc (a sent-only thread that should never
 *   have been triaged):
 *     • under the triage thread lock, strip every Alfred label off the sent
 *       message directly. Only a structured Gmail 404 is treated as already-gone;
 *       transient auth/rate-limit/5xx failures keep the row retryable.
 *     • delete the bogus `email_triage` row. Deleting (vs. dangling the pointer)
 *       respects the briefing inner-join trap: gather inner-joins triage→docs on
 *       `document_id`, so a null/dead pointer silently buries the thread; no row
 *       at all is the clean state, and a future inbound reply re-triages fresh.
 *
 * Distinct from #211 (`isSelfAuthored`, which drops only Alfred's own
 * RESEND_FROM_EMAIL identity): this is the USER's personal Gmail outbound, which
 * relies entirely on the `SENT`-label signal (`isSentGmailMetadata`).
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/repair-sent-mislabeled-triage-committed.js` — the prod
 * image has no `tsx`/loose `@alfred/*` sources.
 *
 * SAFETY: dry by default — lists the rows + planned action but touches nothing
 * (no DB writes, no Gmail calls, no token refresh). Pass `--commit` to repair.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/repair-sent-mislabeled-triage-committed.js
 *   # repair:
 *   node dist/scripts/repair-sent-mislabeled-triage-committed.js --commit
 */
import { closeConnections, closeRedis, warmPool } from "@alfred/api";
import { gmailSentSql, isSentGmailMetadata } from "@alfred/api/modules/triage/sent-mail";
import { loadTriageContext, withTriageThreadLock } from "@alfred/api/modules/triage/store";
import { isHttpError, isTriageCategory, toMessage } from "@alfred/contracts";
import type { TriageCategory } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import {
  ensureAlfredLabels,
  getThreadMessageLabels,
  getFreshAccessToken,
  modifyMessageLabels,
} from "@alfred/integrations/google";
import { and, eq, sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

type DocRow = {
  id: string;
  sourceId: string;
  authoredAt: Date | null;
  accountId: string | null;
  metadata: Record<string, unknown>;
};

type GoogleCredentialRow = Pick<
  typeof integrationCredentials.$inferSelect,
  "id" | "userId" | "accountId"
>;

type CurrentMisPointedRow = {
  category: string;
  documentId: string | null;
  pointedSourceId: string;
  pointedAccountId: string | null;
  pointedIsSent: boolean;
};

type RepairCaseAResult =
  | {
      kind: "repaired";
      targetDocId: string;
      appliedLabelId: string;
      strippedOriginalSent: boolean;
      strippedSiblingCount: number;
    }
  | { kind: "stale"; reason: string };

type RepairCaseBResult =
  | { kind: "deleted"; strippedOriginalSent: boolean }
  | { kind: "stale"; reason: string };

async function loadThreadDocs(userId: string, threadId: string): Promise<DocRow[]> {
  return (await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      authoredAt: documents.authoredAt,
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
    .orderBy(sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`)) as DocRow[];
}

/** Newest non-sent doc — mirrors the runtime live-inbound nulls-last/id tie-breaker. */
function newestInbound(docs: DocRow[]): DocRow | null {
  return docs.find((d) => !isSentGmailMetadata(d.metadata)) ?? null;
}

function newestLiveInbound(
  docs: DocRow[],
  liveSourceIds: ReadonlySet<string>,
  accountId: string | null,
): DocRow | null {
  return (
    docs.find(
      (d) =>
        liveSourceIds.has(d.sourceId) &&
        !isSentGmailMetadata(d.metadata) &&
        (accountId === null || d.accountId === accountId),
    ) ?? null
  );
}

async function loadCurrentMisPointedRow(
  userId: string,
  threadId: string,
): Promise<CurrentMisPointedRow | null> {
  const rows = await db()
    .select({
      category: emailTriage.category,
      documentId: emailTriage.documentId,
      pointedSourceId: documents.sourceId,
      pointedAccountId: documents.accountId,
      pointedIsSent: gmailSentSql(),
    })
    .from(emailTriage)
    .innerJoin(documents, eq(emailTriage.documentId, documents.id))
    .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, threadId)))
    .limit(1);
  return rows[0] ?? null;
}

function resolveGoogleCredentialId(
  creds: readonly GoogleCredentialRow[],
  accountId: string | null,
): string {
  if (accountId) {
    const cred = creds.find((c) => c.accountId === accountId);
    if (cred) return cred.id;
    throw new Error(`no google credential for account=${accountId}`);
  }
  if (creds.length === 1) return creds[0]!.id;
  throw new Error(
    `cannot choose a google credential for null accountId; user has ${creds.length} credentials`,
  );
}

function isGoneInGmail(err: unknown): boolean {
  return isHttpError(err) && err.provider === "gmail" && err.status === 404;
}

async function stripAlfredLabelsFromMessage(args: {
  accessToken: string;
  messageId: string;
  labelIds: readonly string[];
  alfredLabelIds: ReadonlySet<string>;
}): Promise<boolean> {
  const removeLabelIds = args.labelIds.filter((labelId) => args.alfredLabelIds.has(labelId));
  if (removeLabelIds.length === 0) return false;
  try {
    await modifyMessageLabels({
      accessToken: args.accessToken,
      messageId: args.messageId,
      removeLabelIds,
    });
    return true;
  } catch (err) {
    if (isGoneInGmail(err)) return false;
    throw err;
  }
}

async function repairCaseA(args: {
  userId: string;
  threadId: string;
  originalDocumentId: string;
  originalSourceId: string;
  userCreds: readonly GoogleCredentialRow[];
}): Promise<RepairCaseAResult> {
  return withTriageThreadLock(args.userId, args.threadId, async () => {
    const current = await loadCurrentMisPointedRow(args.userId, args.threadId);
    if (!current) return { kind: "stale", reason: "triage row no longer resolves to a document" };
    if (current.documentId !== args.originalDocumentId) {
      return {
        kind: "stale",
        reason: `document changed from ${args.originalDocumentId} to ${current.documentId ?? "null"}`,
      };
    }
    if (!current.pointedIsSent) {
      return { kind: "stale", reason: "row no longer points at a SENT document" };
    }
    if (!isTriageCategory(current.category)) {
      throw new Error(`unknown triage category ${current.category}`);
    }

    const docs = await loadThreadDocs(args.userId, args.threadId);
    const category: TriageCategory = current.category;
    const credId = resolveGoogleCredentialId(args.userCreds, current.pointedAccountId);
    const accessToken = await getFreshAccessToken(credId);
    const liveMessages = await getThreadMessageLabels({ accessToken, threadId: args.threadId });
    const liveSourceIds = new Set(liveMessages.map((m) => m.id));
    const inbound = newestLiveInbound(docs, liveSourceIds, current.pointedAccountId);
    if (!inbound) return { kind: "stale", reason: "no live inbound document remains" };

    const target = await loadTriageContext(inbound.id, args.userId);
    if (!target) throw new Error(`inbound target document disappeared: ${inbound.id}`);
    if (target.credentialId !== credId) {
      throw new Error(
        `live inbound target credential mismatch: pointed=${credId} target=${target.credentialId}`,
      );
    }
    const targetLiveMessage = liveMessages.find((m) => m.id === target.document.sourceId);
    if (!targetLiveMessage) {
      throw new Error(`inbound target message is not live in Gmail: ${target.document.sourceId}`);
    }
    const labels = await ensureAlfredLabels(target.credentialId, { accessToken });
    const targetLabelId = labels.byCategory[category];
    const alfredLabelIds = new Set(labels.allIds);

    const originalLiveMessage = liveMessages.find((m) => m.id === args.originalSourceId);
    const strippedOriginalSent = originalLiveMessage
      ? await stripAlfredLabelsFromMessage({
          accessToken,
          messageId: originalLiveMessage.id,
          labelIds: originalLiveMessage.labelIds,
          alfredLabelIds,
        })
      : false;

    const targetRemoveLabelIds = targetLiveMessage.labelIds.filter(
      (labelId) => alfredLabelIds.has(labelId) && labelId !== targetLabelId,
    );
    await modifyMessageLabels({
      accessToken,
      messageId: target.document.sourceId,
      addLabelIds: [targetLabelId],
      removeLabelIds: targetRemoveLabelIds.length ? targetRemoveLabelIds : undefined,
    });

    let strippedSiblingCount = strippedOriginalSent ? 1 : 0;
    for (const message of liveMessages) {
      if (message.id === target.document.sourceId || message.id === args.originalSourceId) continue;
      const stripped = await stripAlfredLabelsFromMessage({
        accessToken,
        messageId: message.id,
        labelIds: message.labelIds,
        alfredLabelIds,
      });
      if (stripped) strippedSiblingCount++;
    }

    const updated = await db()
      .update(emailTriage)
      .set({
        documentId: inbound.id,
        appliedLabelId: targetLabelId,
        rowVersion: sql`${emailTriage.rowVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailTriage.userId, args.userId),
          eq(emailTriage.sourceThreadId, args.threadId),
          eq(emailTriage.documentId, args.originalDocumentId),
        ),
      )
      .returning({ documentId: emailTriage.documentId });
    if (updated.length === 0) {
      throw new Error(`failed to repoint row after Gmail repair for thread=${args.threadId}`);
    }

    return {
      kind: "repaired",
      targetDocId: inbound.id,
      appliedLabelId: targetLabelId,
      strippedOriginalSent,
      strippedSiblingCount,
    };
  });
}

async function repairCaseB(args: {
  userId: string;
  threadId: string;
  originalDocumentId: string;
  userCreds: readonly GoogleCredentialRow[];
}): Promise<RepairCaseBResult> {
  return withTriageThreadLock(args.userId, args.threadId, async () => {
    const current = await loadCurrentMisPointedRow(args.userId, args.threadId);
    if (!current) return { kind: "stale", reason: "triage row no longer resolves to a document" };
    if (current.documentId !== args.originalDocumentId) {
      return {
        kind: "stale",
        reason: `document changed from ${args.originalDocumentId} to ${current.documentId ?? "null"}`,
      };
    }
    if (!current.pointedIsSent) {
      return { kind: "stale", reason: "row no longer points at a SENT document" };
    }

    const credId = resolveGoogleCredentialId(args.userCreds, current.pointedAccountId);
    const accessToken = await getFreshAccessToken(credId);
    const labels = await ensureAlfredLabels(credId, { accessToken });
    let strippedOriginalSent = false;
    try {
      await modifyMessageLabels({
        accessToken,
        messageId: current.pointedSourceId,
        removeLabelIds: labels.allIds,
      });
      strippedOriginalSent = true;
    } catch (err) {
      if (!isGoneInGmail(err)) throw err;
    }

    const deleted = await db()
      .delete(emailTriage)
      .where(
        and(
          eq(emailTriage.userId, args.userId),
          eq(emailTriage.sourceThreadId, args.threadId),
          eq(emailTriage.documentId, args.originalDocumentId),
        ),
      )
      .returning({ sourceThreadId: emailTriage.sourceThreadId });
    if (deleted.length === 0) {
      throw new Error(`failed to delete sent-only triage row for thread=${args.threadId}`);
    }

    return { kind: "deleted", strippedOriginalSent };
  });
}

async function main() {
  if (COMMIT && !gmailMailboxWritesEnabled()) {
    throw new Error(
      "[repair-sent-mislabeled-triage] refuses to mutate Gmail while mailbox writes are disabled; set GMAIL_MAILBOX_WRITES_ENABLED=true for a committed repair",
    );
  }

  await warmPool();
  console.log(`# Sent-mislabel triage repair (#306) — mode=${COMMIT ? "COMMIT" : "DRY"}`);

  // Single-user app, but resolve users + a per-account credential map correctly.
  const creds = await db()
    .select({
      id: integrationCredentials.id,
      userId: integrationCredentials.userId,
      accountId: integrationCredentials.accountId,
    })
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, "google"));
  if (creds.length === 0) {
    console.log("no google credentials in this DB — nothing to repair");
    return;
  }
  const credsByUser = new Map<string, GoogleCredentialRow[]>();
  for (const cred of creds) {
    const existing = credsByUser.get(cred.userId);
    if (existing) existing.push(cred);
    else credsByUser.set(cred.userId, [cred]);
  }
  const userIds = [...new Set(creds.map((c) => c.userId))];

  let totalMisPointed = 0;
  let repaintedA = 0;
  let deletedB = 0;
  let labelsStripped = 0;
  let errors = 0;

  for (const userId of userIds) {
    // Mis-pointed rows: triage row whose pointed doc is sent (flag OR SENT label).
    const misPointed = await db()
      .select({
        threadId: emailTriage.sourceThreadId,
        category: emailTriage.category,
        documentId: emailTriage.documentId,
        appliedLabelId: emailTriage.appliedLabelId,
        classifiedAt: emailTriage.classifiedAt,
        pointedSourceId: documents.sourceId,
        pointedAccountId: documents.accountId,
        pointedFrom: sql<string | null>`${documents.metadata}->>'from'`,
      })
      .from(emailTriage)
      .innerJoin(documents, eq(emailTriage.documentId, documents.id))
      .where(and(eq(emailTriage.userId, userId), gmailSentSql()));

    if (misPointed.length === 0) continue;
    console.log(`\n=== user=${userId} — ${misPointed.length} mis-pointed row(s) ===`);
    totalMisPointed += misPointed.length;
    const userCreds = credsByUser.get(userId) ?? [];

    for (const row of misPointed) {
      if (!row.documentId) {
        errors++;
        console.warn(`     ! scan returned a row without document_id for thread=${row.threadId}`);
        continue;
      }
      const threadId = row.threadId;
      const docs = await loadThreadDocs(userId, threadId);
      const inbound = newestInbound(docs);
      console.log(
        `\nthread=${threadId} cat=${row.category} classified=${row.classifiedAt?.toISOString() ?? "?"}`,
      );
      console.log(
        `  points_at_SENT=${row.documentId} (from=${row.pointedFrom ?? "?"}) appliedLabel=${row.appliedLabelId ?? "none"}`,
      );

      if (inbound) {
        // ---- Case A: strip sent label + apply inbound label + repoint.
        console.log(
          `  → CASE A: strip sent label, apply inbound label, repoint → ${inbound.id} (authored ${inbound.authoredAt?.toISOString() ?? "?"})`,
        );
        if (!COMMIT) continue;
        try {
          const result = await repairCaseA({
            userId,
            threadId,
            originalDocumentId: row.documentId,
            originalSourceId: row.pointedSourceId,
            userCreds,
          });
          if (result.kind === "repaired") {
            repaintedA++;
            if (result.strippedOriginalSent) labelsStripped++;
            console.log(
              `     PERSISTED — label=${result.appliedLabelId} applied to ${result.targetDocId}; ` +
                `stripped ${result.strippedSiblingCount} sibling label(s)` +
                `${result.strippedOriginalSent ? " (incl. the sent message)" : " (sent label already gone)"}`,
            );
          } else {
            console.log(`     skipped stale row: ${result.reason}`);
          }
        } catch (err) {
          errors++;
          console.warn(`     ! repair failed: ${toMessage(err)}`);
        }
        continue;
      }

      // ---- Case B: sent-only thread — strip label, delete the bogus row.
      console.log(
        `  → CASE B: no inbound doc — strip Alfred label off sent msg + delete triage row`,
      );
      if (!COMMIT) continue;
      try {
        const result = await repairCaseB({
          userId,
          threadId,
          originalDocumentId: row.documentId,
          userCreds,
        });
        if (result.kind === "deleted") {
          if (result.strippedOriginalSent) {
            labelsStripped++;
            console.log(`     stripped Alfred labels off sent msg ${row.pointedSourceId}`);
          } else {
            console.log(`     sent msg ${row.pointedSourceId} already gone or unlabeled`);
          }
          deletedB++;
          console.log(`     PERSISTED — deleted bogus triage row for thread ${threadId}`);
        } else {
          console.log(`     skipped stale row: ${result.reason}`);
        }
      } catch (err) {
        errors++;
        console.warn(`     ! repair failed: ${toMessage(err)}`);
      }
    }
  }

  console.log(
    `\n# ${COMMIT ? "DONE" : "DRY"} — ${totalMisPointed} mis-pointed row(s); ` +
      `${COMMIT ? `repointed ${repaintedA}, deleted ${deletedB}, labels stripped ${labelsStripped}, errors ${errors}` : "run with --commit to repair"}`,
  );
}

main()
  .catch((e) => {
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

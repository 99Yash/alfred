/**
 * Repair legacy triage rows that point at the user's own SENT message and labeled
 * it (ADR-0051 #7, #306). The classify guard stops new cases; this fixes old rows.
 *
 *   A. The thread has an inbound doc: under the thread lock, strip Alfred labels
 *      off the sent message, label the newest inbound doc, and repoint the row.
 *   B. Sent-only thread: strip the labels and delete the row. A dead pointer would
 *      hide the thread from the briefing inner join. Only a Gmail 404 counts as gone.
 *
 * Bundled for prod. Dry by default (no DB writes, no Gmail calls, no token refresh).
 * `--commit` repairs.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/repairs/repair-sent-mislabeled-triage-committed.js
 *   # repair:
 *   node dist/scripts/repairs/repair-sent-mislabeled-triage-committed.js --commit
 */
import { warmPool } from "@alfred/db";
import { gmailSentSql } from "@alfred/assistant/triage/sent-mail";
import { loadTriageContext, withTriageThreadLock } from "@alfred/assistant/triage/store";
import type { TriageCategory } from "@alfred/contracts";
import { isHttpError, isSentGmailMetadata, isTriageCategory, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  documents,
  emailTriage,
  integrationCredentials,
  type IntegrationCredential,
} from "@alfred/db/schemas";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
import {
  ensureAlfredLabels,
  getFreshAccessToken,
  getThreadMessageLabels,
  modifyMessageLabels,
} from "@alfred/integrations/google";
import { and, eq, sql } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

type DocRow = {
  id: string;
  sourceId: string;
  authoredAt: Date | null;
  accountId: string | null;
  metadata: unknown;
};

type GoogleCredentialRow = Pick<IntegrationCredential, "id" | "userId" | "accountId">;

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
  return await db()
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
    .orderBy(sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`);
}

/** Newest non-sent doc, with the same nulls-last and id tie-break as the runtime. */
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
    // Rows whose document is sent (flag or SENT label).
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
        // Case A: strip, label the inbound doc, repoint.
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

      // Case B: sent-only thread. Strip, then delete the row.
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
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });

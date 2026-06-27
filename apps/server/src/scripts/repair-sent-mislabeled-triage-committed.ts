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
 *     • repoint `email_triage.document_id` → newest inbound doc, clear
 *       `applied_label_id` (never let sent mail be the canonical/labeled doc).
 *     • run {@link reconcileThreadLabel} — the ONE canonical Gmail label-writer.
 *       It re-applies the row's category to the inbound message AND strips every
 *       thread sibling's Alfred label, which removes the erroneous label off the
 *       user's own sent message (Gmail unions labels across a thread, so the
 *       sibling-strip is exactly the un-label we need). No drift with runtime.
 *
 *   Case B — the thread has NO inbound doc (a sent-only thread that should never
 *   have been triaged):
 *     • strip every Alfred label off the sent message directly (best-effort —
 *       Gmail may have reassigned the id; a 404 means the label is already gone).
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
import { reconcileThreadLabel } from "@alfred/api/modules/triage/tags";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import {
  ensureAlfredLabels,
  getFreshAccessToken,
  modifyMessageLabels,
} from "@alfred/integrations/google";
import { and, desc, eq, sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

type DocRow = {
  id: string;
  sourceId: string;
  authoredAt: Date | null;
  accountId: string | null;
  metadata: Record<string, unknown>;
};

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
    .orderBy(desc(documents.authoredAt))) as DocRow[];
}

/** Newest non-sent doc — mirrors the `NOT(gmailSentSql()) ORDER BY authoredAt DESC LIMIT 1` rule. */
function newestInbound(docs: DocRow[]): DocRow | null {
  return docs.find((d) => !isSentGmailMetadata(d.metadata)) ?? null;
}

async function main() {
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
  const credByAccount = new Map(creds.map((c) => [c.accountId, c.id]));
  const fallbackCredId = creds[0]!.id;
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

    for (const row of misPointed) {
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
        // ---- Case A: repoint to inbound + canonical relabel (strips sent label).
        console.log(
          `  → CASE A: repoint → ${inbound.id} (inbound, authored ${inbound.authoredAt?.toISOString() ?? "?"}) + reconcile label`,
        );
        if (!COMMIT) continue;
        try {
          await db()
            .update(emailTriage)
            .set({
              documentId: inbound.id,
              appliedLabelId: null,
              rowVersion: sql`${emailTriage.rowVersion} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, threadId)));
          const result = await reconcileThreadLabel({ userId, sourceThreadId: threadId });
          if (result.applied) {
            repaintedA++;
            const strippedSent = result.strippedSiblings.some(
              (s) => s.messageId === row.pointedSourceId,
            );
            if (strippedSent) labelsStripped++;
            console.log(
              `     PERSISTED — repointed; label=${result.appliedLabelId} applied to ${result.targetDocId}; ` +
                `stripped ${result.strippedSiblings.length} sibling label(s)${strippedSent ? " (incl. the sent message)" : ""}`,
            );
          } else {
            console.log(`     repointed but relabel skipped: ${result.reason}`);
            repaintedA++;
          }
        } catch (err) {
          errors++;
          console.warn(`     ! repair failed: ${toMessage(err)}`);
        }
        continue;
      }

      // ---- Case B: sent-only thread — strip label, delete the bogus row.
      console.log(`  → CASE B: no inbound doc — strip Alfred label off sent msg + delete triage row`);
      if (!COMMIT) continue;
      try {
        const credId =
          (row.pointedAccountId && credByAccount.get(row.pointedAccountId)) ?? fallbackCredId;
        const accessToken = await getFreshAccessToken(credId);
        const labels = await ensureAlfredLabels(credId, { accessToken });
        try {
          await modifyMessageLabels({
            accessToken,
            messageId: row.pointedSourceId,
            removeLabelIds: labels.allIds,
          });
          labelsStripped++;
          console.log(`     stripped Alfred labels off sent msg ${row.pointedSourceId}`);
        } catch (err) {
          // Gmail reassigns message ids on send/merge — a 404 means the id is
          // dead and the label is already gone with it. Proceed to delete the row.
          console.warn(
            `     label strip skipped (likely dead msg id ${row.pointedSourceId}): ${toMessage(err)}`,
          );
        }
        await db()
          .delete(emailTriage)
          .where(and(eq(emailTriage.userId, userId), eq(emailTriage.sourceThreadId, threadId)));
        deletedB++;
        console.log(`     PERSISTED — deleted bogus triage row for thread ${threadId}`);
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

/**
 * One-shot backfill: collapse multi-label Gmail threads down to one label.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/backfill-thread-labels.ts
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/backfill-thread-labels.ts --dry-run
 *
 * Background: every Gmail message gets its own `email_triage` row + alfred
 * label. Gmail's thread view unions labels across messages, so when a reply
 * lands in a thread that previously classified as e.g. `fyi` and now reads
 * as `done`, the thread shows BOTH labels. The forward fix (workflow strips
 * sibling labels on re-classification) keeps this clean going forward — this
 * script clears the existing mess.
 *
 * Strategy: for every (userId, sourceThreadId) tuple where the thread has
 * more than one alfred-labelled message, keep the label on the latest message
 * (by `authoredAt desc`, falling back to `ingestedAt`) and strip every other
 * sibling's alfred label. Sibling triage rows have `applied_label_id` cleared
 * but the `category` (audit) is preserved.
 *
 * Idempotent: re-running is a no-op once a thread has been collapsed.
 */
import { closeConnections, warmPool, clearAppliedLabelIds } from "@alfred/api";
import { db } from "@alfred/db";
import { documents, emailTriage, integrationCredentials } from "@alfred/db/schemas";
import { getFreshAccessToken, modifyMessageLabels } from "@alfred/integrations/google";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

interface SiblingRow {
  documentId: string;
  sourceId: string;
  appliedLabelId: string;
  authoredAt: Date | null;
  ingestedAt: Date;
  accountId: string | null;
}

const dryRun = process.argv.includes("--dry-run");

async function main() {
  await warmPool();
  console.log(`[backfill-thread-labels] start ${dryRun ? "(DRY RUN)" : ""}`);

  // ---- 1. Find every thread with >1 alfred-labelled message ----------------
  //
  // Group documents by (user, thread) where the thread has multiple messages
  // with a non-null applied_label_id on their triage row. SQL does the dedup
  // for us; we then load the per-message detail in a second query.
  const groups = await db()
    .select({
      userId: documents.userId,
      sourceThreadId: documents.sourceThreadId,
      labelledCount: sql<number>`count(*)::int`.as("labelled_count"),
    })
    .from(documents)
    .innerJoin(emailTriage, eq(emailTriage.documentId, documents.id))
    .where(
      and(
        eq(documents.source, "gmail"),
        isNotNull(documents.sourceThreadId),
        isNotNull(emailTriage.appliedLabelId),
      ),
    )
    .groupBy(documents.userId, documents.sourceThreadId)
    .having(sql`count(*) > 1`);

  console.log(`[backfill-thread-labels] candidate threads: ${groups.length}`);
  if (groups.length === 0) {
    console.log("[backfill-thread-labels] nothing to do.");
    return;
  }

  // Cache credential lookups by (userId, accountId) — most threads in a
  // mailbox share a single credential, so a Map saves a lot of DB hits.
  const credByAccount = new Map<string, string>();
  const credForAccount = async (userId: string, accountId: string): Promise<string | null> => {
    const key = `${userId}:${accountId}`;
    const cached = credByAccount.get(key);
    if (cached) return cached;
    const rows = await db()
      .select({ id: integrationCredentials.id })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.userId, userId),
          eq(integrationCredentials.provider, "google"),
          eq(integrationCredentials.accountId, accountId),
        ),
      );
    const id = rows[0]?.id ?? null;
    if (id) credByAccount.set(key, id);
    return id;
  };

  let threadsTouched = 0;
  let messagesStripped = 0;
  let messagesSkipped = 0;
  let messagesFailed = 0;

  for (const group of groups) {
    if (!group.sourceThreadId) continue;

    // ---- 2. Pull each labelled sibling, newest first ----------------------
    const siblings = (await db()
      .select({
        documentId: documents.id,
        sourceId: documents.sourceId,
        appliedLabelId: emailTriage.appliedLabelId,
        authoredAt: documents.authoredAt,
        ingestedAt: documents.ingestedAt,
        accountId: documents.accountId,
      })
      .from(documents)
      .innerJoin(emailTriage, eq(emailTriage.documentId, documents.id))
      .where(
        and(
          eq(documents.userId, group.userId),
          eq(documents.source, "gmail"),
          eq(documents.sourceThreadId, group.sourceThreadId),
          isNotNull(emailTriage.appliedLabelId),
        ),
      )
      .orderBy(
        desc(documents.authoredAt),
        desc(documents.ingestedAt),
      )) as SiblingRow[];

    if (siblings.length < 2) continue;

    const [keep, ...drop] = siblings;
    if (!keep) continue;

    // If every sibling already shares the same label, Gmail's thread view
    // shows one tag — nothing to strip, just clear the DB so the schema
    // matches reality (older rows shouldn't claim to hold a label they
    // share with the kept one).
    const sameLabelEverywhere = drop.every((s) => s.appliedLabelId === keep.appliedLabelId);
    if (sameLabelEverywhere) {
      if (!dryRun) {
        await clearAppliedLabelIds(drop.map((s) => s.documentId));
      }
      threadsTouched++;
      messagesSkipped += drop.length;
      console.log(
        `[backfill-thread-labels] thread=${group.sourceThreadId} user=${group.userId} ` +
          `same-label across ${siblings.length} msgs; cleared ${drop.length} duplicate row(s)`,
      );
      continue;
    }

    threadsTouched++;
    console.log(
      `[backfill-thread-labels] thread=${group.sourceThreadId} user=${group.userId} ` +
        `keep=msg:${keep.sourceId} drop=${drop.length}`,
    );

    if (dryRun) {
      messagesSkipped += drop.length;
      continue;
    }

    const strippedDocIds: string[] = [];
    for (const sibling of drop) {
      // Each Gmail message lives under a specific connected account. Resolve
      // the credential per-message — a single thread can technically span
      // accounts if the user has multiple connections in the same mailbox.
      if (!sibling.accountId) {
        console.warn(
          `[backfill-thread-labels]   msg=${sibling.sourceId} missing accountId, skipping`,
        );
        messagesFailed++;
        continue;
      }
      const credentialId = await credForAccount(group.userId, sibling.accountId);
      if (!credentialId) {
        console.warn(
          `[backfill-thread-labels]   msg=${sibling.sourceId} no credential for ` +
            `account=${sibling.accountId}, skipping`,
        );
        messagesFailed++;
        continue;
      }

      try {
        const accessToken = await getFreshAccessToken(credentialId);
        await modifyMessageLabels({
          accessToken,
          messageId: sibling.sourceId,
          removeLabelIds: [sibling.appliedLabelId],
        });
        strippedDocIds.push(sibling.documentId);
        messagesStripped++;
      } catch (err) {
        // Common: the Gmail message was deleted out of band, or the label
        // was already removed manually. Log and move on so one bad sibling
        // doesn't block the rest of the backfill.
        console.warn(
          `[backfill-thread-labels]   msg=${sibling.sourceId} strip failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        messagesFailed++;
      }
    }

    if (strippedDocIds.length) {
      await clearAppliedLabelIds(strippedDocIds);
    }
  }

  console.log(
    `\n[backfill-thread-labels] done ${dryRun ? "(DRY RUN)" : ""}\n` +
      `  threadsTouched=${threadsTouched}\n` +
      `  messagesStripped=${messagesStripped}\n` +
      `  messagesSkipped=${messagesSkipped}\n` +
      `  messagesFailed=${messagesFailed}`,
  );
}

main()
  .catch((err) => {
    console.error(
      "[backfill-thread-labels] FAIL",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections().catch(() => {});
  });

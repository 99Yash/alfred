/**
 * COMMITTED self-mail retirement backfill (issue #211, one-off 2026-06-21).
 *
 * Alfred's own briefing/approval emails (`From` = `RESEND_FROM_EMAIL`,
 * e.g. `"Alfred <hey@alfred.beauty>"`) re-entered the connected inbox as
 * ordinary inbound mail, got ingested as `documents`, and were triaged into
 * the demanding lanes — then re-fed into the next briefing (a self-amplifying
 * loop). The ingestion-time guard in `@alfred/integrations` stops *new*
 * self-mail; this retires the rows already on file so the existing snowball
 * clears.
 *
 * What it removes, scoped to the target user(s) — only for threads that are
 * PURELY self-authored (Alfred sends each briefing as its own thread, so this
 * is the norm):
 *   1. The `email_triage` row for the thread.
 *   2. The self-authored `documents` rows in it (chunks cascade via FK).
 * A thread that ALSO carries a real inbound message is left fully intact —
 * both its self-docs and its triage row. We must not delete a self-doc while
 * keeping the thread's triage row: `email_triage.document_id` is nullable and
 * `briefing/gather` *inner*-joins triage→documents on it, so a dangling
 * pointer silently drops the whole thread (real email included) from every
 * future briefing.
 *
 * Matching mirrors the ingestion guard (`isSelfAuthored`): a coarse `LIKE`
 * candidate filter, then an EXACT parsed-address match — so this destructive
 * pass retires exactly the set the runtime filter now drops, never mail that
 * merely mentions the address in display text.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfill-retire-self-mail-committed.js` — the prod image
 * has no `tsx`/loose `@alfred/*` sources.
 *
 * SAFETY: dry by default — counts + lists but writes nothing. Pass `--commit`
 * to delete.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfill-retire-self-mail-committed.js
 *   # commit:
 *   node dist/scripts/backfill-retire-self-mail-committed.js --commit
 *   # override target(s):
 *   node dist/scripts/backfill-retire-self-mail-committed.js --emails=a@x.com,b@y.com --commit
 */
import { closeConnections, closeRedis, warmPool } from "@alfred/api";
import { parseEmailAddress, toMessage } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { db } from "@alfred/db";
import { documents, emailTriage, user as userTable } from "@alfred/db/schemas";
import { selfSenderEmail } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Mailboxes to clean. Override with `--emails=a@x.com,b@y.com` (a CLI arg, not
 * an env var — the repo forbids direct `process.env` and the typed env schema
 * has no slot for a one-off script knob).
 */
function parseTargetEmails(): string[] {
  const flag = process.argv.find((a) => a.startsWith("--emails="));
  const raw = flag ? flag.slice("--emails=".length) : "yashgouravkar@gmail.com";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const TARGET_EMAILS = parseTargetEmails();

const COMMIT = process.argv.includes("--commit");

async function processUser(u: { userId: string; email: string }, selfAddr: string): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  // Candidate self-docs: coarse substring filter on `metadata.from`, then an
  // EXACT parsed-address match (the LIKE alone over-matches mail that merely
  // mentions the address in display text, and this delete is destructive).
  const candidates = await db()
    .select({
      id: documents.id,
      threadId: documents.sourceThreadId,
      title: documents.title,
      from: sql<string | null>`${documents.metadata}->>'from'`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, u.userId),
        eq(documents.source, "gmail"),
        sql`lower(${documents.metadata}->>'from') like ${"%" + selfAddr + "%"}`,
      ),
    );
  const selfDocs = candidates.filter((d) => parseEmailAddress(d.from) === selfAddr);

  if (selfDocs.length === 0) {
    console.log("  no self-authored documents on file — nothing to retire");
    return;
  }

  const threadIds = [...new Set(selfDocs.map((d) => d.threadId).filter((t): t is string => !!t))];

  // Classify each candidate thread as PURE (every message self-authored) or
  // MIXED (also carries a real inbound message), using the same exact-address
  // semantics. A thread is mixed iff it holds a doc whose `from` is NOT self.
  const threadDocs = threadIds.length
    ? await db()
        .select({
          threadId: documents.sourceThreadId,
          from: sql<string | null>`${documents.metadata}->>'from'`,
        })
        .from(documents)
        .where(
          and(
            eq(documents.userId, u.userId),
            eq(documents.source, "gmail"),
            inArray(documents.sourceThreadId, threadIds),
          ),
        )
    : [];
  const mixedSet = new Set<string>();
  for (const d of threadDocs) {
    if (d.threadId && parseEmailAddress(d.from) !== selfAddr) mixedSet.add(d.threadId);
  }
  const pureThreadIds = threadIds.filter((t) => !mixedSet.has(t));
  const pureThreadSet = new Set(pureThreadIds);

  // Only delete self-docs that are safe to remove: those in a purely-self
  // thread (whose triage row we also delete below), or standalone (no thread →
  // no triage row to orphan). Self-docs sitting in a MIXED thread are skipped
  // entirely — deleting one while its thread's triage row survives would dangle
  // `email_triage.document_id` and drop the real email from briefings (see
  // header). Rare (Alfred self-threads each briefing), but the guard is exact.
  const deletableDocs = selfDocs.filter((d) => !d.threadId || pureThreadSet.has(d.threadId));
  const skippedMixedDocs = selfDocs.length - deletableDocs.length;
  const docIds = deletableDocs.map((d) => d.id);

  console.log(`  ${selfDocs.length} self-authored docs across ${threadIds.length} threads`);
  if (mixedSet.size) {
    console.log(
      `  ! ${mixedSet.size} mixed thread(s) also contain non-self mail — docs AND triage LEFT intact (${skippedMixedDocs} self-doc(s) skipped)`,
    );
  }
  for (const d of deletableDocs.slice(0, 15)) {
    console.log(`    doc=${d.id} thread=${d.threadId} | ${d.from} | ${d.title ?? "(no subject)"}`);
  }
  if (deletableDocs.length > 15) console.log(`    … and ${deletableDocs.length - 15} more`);

  if (!COMMIT) {
    console.log(
      `  DRY — would delete ${docIds.length} docs and triage for ${pureThreadIds.length} pure threads`,
    );
    return;
  }

  const triageDeleted = pureThreadIds.length
    ? await db()
        .delete(emailTriage)
        .where(
          and(eq(emailTriage.userId, u.userId), inArray(emailTriage.sourceThreadId, pureThreadIds)),
        )
        .returning({ threadId: emailTriage.sourceThreadId })
    : [];

  const docsDeleted = docIds.length
    ? await db()
        .delete(documents)
        .where(and(eq(documents.userId, u.userId), inArray(documents.id, docIds)))
        .returning({ id: documents.id })
    : [];

  console.log(
    `  PERSISTED — deleted ${docsDeleted.length} documents + ${triageDeleted.length} triage rows`,
  );
}

async function main() {
  await warmPool();
  // Shared with the ingestion guard via `@alfred/integrations/google`, so the
  // candidate→exact match here retires exactly the set the runtime filter drops.
  const selfAddr = selfSenderEmail();
  if (!selfAddr) {
    throw new Error(`RESEND_FROM_EMAIL has no parseable address: ${serverEnv().RESEND_FROM_EMAIL}`);
  }
  console.log(
    `# Self-mail retirement — mode=${COMMIT ? "COMMIT" : "DRY"} | self=${selfAddr} | targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));
  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
  }

  for (const u of users) await processUser(u, selfAddr);

  console.log("\n# done");
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

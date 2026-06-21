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
 * What it removes, scoped to the target user(s):
 *   1. `email_triage` rows for every thread whose documents are all
 *      self-authored (Alfred sends each briefing as its own thread, so these
 *      threads never contain a real inbound message).
 *   2. The self-authored `documents` rows themselves (chunks cascade via FK).
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
 *   SELF_MAIL_EMAILS="a@x.com" node dist/scripts/backfill-retire-self-mail-committed.js --commit
 */
import { closeConnections, closeRedis, warmPool } from "@alfred/api";
import { serverEnv } from "@alfred/env/server";
import { db } from "@alfred/db";
import { documents, emailTriage, user as userTable } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";

/** Mailboxes to clean. Override with `SELF_MAIL_EMAILS` (comma-sep). */
const TARGET_EMAILS = (process.env.SELF_MAIL_EMAILS ?? "yashgouravkar@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COMMIT = process.argv.includes("--commit");

/** Bare `local@domain` from `RESEND_FROM_EMAIL` — the SSOT for Alfred's identity. */
function selfSenderEmail(): string {
  const raw = serverEnv().RESEND_FROM_EMAIL;
  const addr = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
  if (!addr.includes("@")) {
    throw new Error(`RESEND_FROM_EMAIL has no parseable address: ${raw}`);
  }
  return addr;
}

async function processUser(u: { userId: string; email: string }, selfAddr: string): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  // Self-authored gmail docs: `metadata.from` contains Alfred's send address.
  const selfDocs = await db()
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

  if (selfDocs.length === 0) {
    console.log("  no self-authored documents on file — nothing to retire");
    return;
  }

  const docIds = selfDocs.map((d) => d.id);
  const threadIds = [...new Set(selfDocs.map((d) => d.threadId).filter((t): t is string => !!t))];

  // Guard: only retire triage for threads that are PURELY self-authored.
  // (Alfred sends each briefing as its own thread, so this is the norm — but
  // we never want to drop a real email's tag if a thread somehow mixes both.)
  const mixedThreads = threadIds.length
    ? await db()
        .select({ threadId: documents.sourceThreadId })
        .from(documents)
        .where(
          and(
            eq(documents.userId, u.userId),
            eq(documents.source, "gmail"),
            inArray(documents.sourceThreadId, threadIds),
            sql`lower(${documents.metadata}->>'from') not like ${"%" + selfAddr + "%"}`,
          ),
        )
    : [];
  const mixedSet = new Set(mixedThreads.map((r) => r.threadId));
  const pureThreadIds = threadIds.filter((t) => !mixedSet.has(t));

  console.log(`  ${selfDocs.length} self-authored docs across ${threadIds.length} threads`);
  if (mixedSet.size) {
    console.log(
      `  ! ${mixedSet.size} thread(s) also contain non-self mail — their triage is LEFT intact`,
    );
  }
  for (const d of selfDocs.slice(0, 15)) {
    console.log(`    doc=${d.id} thread=${d.threadId} | ${d.from} | ${d.title ?? "(no subject)"}`);
  }
  if (selfDocs.length > 15) console.log(`    … and ${selfDocs.length - 15} more`);

  if (!COMMIT) {
    console.log(
      `  DRY — would delete ${selfDocs.length} docs and triage for ${pureThreadIds.length} pure threads`,
    );
    return;
  }

  const triageDeleted = pureThreadIds.length
    ? await db()
        .delete(emailTriage)
        .where(
          and(
            eq(emailTriage.userId, u.userId),
            inArray(emailTriage.sourceThreadId, pureThreadIds),
          ),
        )
        .returning({ threadId: emailTriage.sourceThreadId })
    : [];

  const docsDeleted = await db()
    .delete(documents)
    .where(and(eq(documents.userId, u.userId), inArray(documents.id, docIds)))
    .returning({ id: documents.id });

  console.log(
    `  PERSISTED — deleted ${docsDeleted.length} documents + ${triageDeleted.length} triage rows`,
  );
}

async function main() {
  await warmPool();
  const selfAddr = selfSenderEmail();
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
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

/**
 * Retire Alfred's own mail already in the inbox (#211). Briefings sent from
 * `RESEND_FROM_EMAIL` came back as inbound mail and fed the next briefing.
 * The ingestion guard stops new self-mail; this clears the old rows.
 *
 * For a purely self-authored thread it deletes the `email_triage` row and the
 * self-authored `documents` (chunks cascade). A mixed thread stays intact: a deleted
 * doc under a kept triage row drops the whole thread from briefings.
 * It matches the exact parsed address, like `isSelfAuthored`, not only the `LIKE`.
 *
 * Bundled for prod. Dry by default; `--commit` deletes.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-retire-self-mail-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-retire-self-mail-committed.js --commit
 *   # override target(s):
 *   node dist/scripts/backfills/backfill-retire-self-mail-committed.js --emails=a@x.com,b@y.com --commit
 */
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { parseEmailAddress, toMessage } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { db } from "@alfred/db";
import { documents, emailTriage, user as userTable } from "@alfred/db/schemas";
import { selfSenderEmail } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";

/** Mailboxes to clean. Override with `--emails=a@x.com,b@y.com`. */
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

  // LIKE finds candidates; the exact parsed match decides. LIKE also hits display text.
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

  // A thread is mixed if any message is not self-authored.
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

  // Delete only docs in a pure thread or with no thread. Skip mixed threads.
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
  // The same address the ingestion guard drops.
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
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });

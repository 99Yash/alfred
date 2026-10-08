/**
 * Retire self-mail sent from historical Alfred aliases (#266). The #211 script
 * matched only the current `RESEND_FROM_EMAIL`, so it missed old briefings and
 * approvals from `yash@croisillies.xyz`. This one matches the current address plus the aliases.
 *
 * For a purely self-authored thread it deletes the `email_triage` row and the
 * self-authored `documents` (chunks cascade). A mixed thread stays intact: a deleted
 * doc under a kept triage row drops the whole thread from briefings.
 * It matches the exact parsed address, not only the `LIKE`, because the delete is destructive.
 *
 * Bundled for prod. Dry by default; `--commit` deletes.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-retire-self-mail-aliases-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-retire-self-mail-aliases-committed.js --commit
 *   # override target(s) / aliases:
 *   node dist/scripts/backfills/backfill-retire-self-mail-aliases-committed.js --emails=a@x.com --aliases=old@y.com,other@z.com --commit
 */
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { parseEmailAddress, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, user as userTable } from "@alfred/db/schemas";
import { selfSenderEmail } from "@alfred/integrations/google";
import { and, eq, inArray, or, sql } from "drizzle-orm";

function parseListFlag(flag: string, fallback: string): string[] {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  const raw = arg ? arg.slice(`${flag}=`.length) : fallback;

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseListFlag("--emails", "yashgouravkar@gmail.com");

// Old send-from aliases that `RESEND_FROM_EMAIL` no longer matches (#266).
const ALIAS_INPUT = parseListFlag("--aliases", "yash@croisillies.xyz");

const COMMIT = process.argv.includes("--commit");

async function processUser(
  u: { userId: string; email: string },
  selfAddrs: Set<string>,
): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const addrList = [...selfAddrs];

  // LIKE finds candidates; the exact parsed match below decides. LIKE also hits display text.
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
        or(
          ...addrList.map((a) => sql`lower(${documents.metadata}->>'from') like ${"%" + a + "%"}`),
        ),
      ),
    );

  const isSelf = (from: string | null): boolean => {
    const parsed = parseEmailAddress(from);

    return parsed !== null && selfAddrs.has(parsed);
  };

  const selfDocs = candidates.filter((d) => isSelf(d.from));

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
    if (d.threadId && !isSelf(d.from)) mixedSet.add(d.threadId);
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

  const { triageDeleted, docsDeleted } = await db().transaction(async (tx) => {
    const triageDeleted = pureThreadIds.length
      ? await tx
          .delete(emailTriage)
          .where(
            and(
              eq(emailTriage.userId, u.userId),
              inArray(emailTriage.sourceThreadId, pureThreadIds),
            ),
          )
          .returning({ threadId: emailTriage.sourceThreadId })
      : [];

    const docsDeleted = docIds.length
      ? await tx
          .delete(documents)
          .where(and(eq(documents.userId, u.userId), inArray(documents.id, docIds)))
          .returning({ id: documents.id })
      : [];

    return { triageDeleted, docsDeleted };
  });

  console.log(
    `  PERSISTED — deleted ${docsDeleted.length} documents + ${triageDeleted.length} triage rows`,
  );
}

async function main() {
  await warmPool();

  // Current address plus aliases, parsed like the runtime guard parses them.
  const selfAddrs = new Set<string>();
  const current = selfSenderEmail();

  if (current) selfAddrs.add(current);
  const unparsed: string[] = [];

  for (const a of ALIAS_INPUT) {
    const parsed = parseEmailAddress(a);

    if (parsed) selfAddrs.add(parsed);
    else unparsed.push(a);
  }

  if (unparsed.length) console.log(`! ignored unparseable alias(es): ${unparsed.join(", ")}`);

  if (selfAddrs.size === 0) {
    throw new Error("no self addresses to match (RESEND_FROM_EMAIL unparseable and no aliases)");
  }

  console.log(
    `# Self-mail alias retirement — mode=${COMMIT ? "COMMIT" : "DRY"} | self-set={${[...selfAddrs].join(", ")}} | targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));

  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
  }

  for (const u of users) await processUser(u, selfAddrs);

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

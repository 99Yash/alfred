/**
 * COMMITTED self-mail retirement backfill — HISTORICAL ALIASES (issue #266).
 *
 * The #211 backfill (`backfill-retire-self-mail-committed.ts`) retired only mail
 * from the CURRENT `RESEND_FROM_EMAIL`. But Alfred's earlier briefings shipped
 * from an OLDER envelope — `yash@croisillies.xyz` — before the address changed,
 * and the daily-briefing / HIL-approval rows sent from that alias survived on the
 * personal account (`yashgouravkar@gmail.com`), still tagged into the demanding
 * lanes and inflating the `urgent` count (#210). The current-address filter can
 * never catch them, so this pass matches the current self address PLUS an
 * explicit historical-alias list.
 *
 * NOTE ON THE FORWARD DROP: no code change is needed to stop NEW self-mail — all
 * Alfred outbound (briefing AND HIL approval) ships through one path
 * (`notify.ts` → `from: RESEND_FROM_EMAIL`), and `isSelfAuthored` already drops
 * that envelope (locked by `test/integrations/self-authored-drop.test.ts`). This
 * script is purely a one-off cleanup of the pre-existing rows from the OLD alias.
 *
 * What it removes, scoped to the target user(s) — only for threads that are
 * PURELY self-authored (Alfred sends each briefing/approval as its own thread):
 *   1. The `email_triage` row for the thread.
 *   2. The self-authored `documents` rows in it (chunks cascade via FK).
 * A thread that ALSO carries a real inbound message is left FULLY intact — both
 * its self-docs and its triage row. Deleting a self-doc while keeping the
 * thread's triage row would dangle `email_triage.document_id` (nullable, and
 * briefing/gather INNER-joins triage→documents on it), silently dropping the
 * whole thread — real email included — from every future briefing. (Same guard
 * and rationale as the #211 script.)
 *
 * Matching mirrors the ingestion guard (`isSelfAuthored`): a coarse `LIKE`
 * candidate filter per address, then an EXACT parsed-address match against the
 * self-set — so this destructive pass retires exactly self-authored mail, never
 * mail that merely mentions one of the addresses in display text.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfill-retire-self-mail-aliases-committed.js`.
 *
 * SAFETY: dry by default — counts + lists but writes nothing. Pass `--commit`
 * to delete.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfill-retire-self-mail-aliases-committed.js
 *   # commit:
 *   node dist/scripts/backfill-retire-self-mail-aliases-committed.js --commit
 *   # override target(s) / aliases:
 *   node dist/scripts/backfill-retire-self-mail-aliases-committed.js --emails=a@x.com --aliases=old@y.com,other@z.com --commit
 */
import { closeConnections, closeRedis, warmPool } from "@alfred/api";
import { parseEmailAddress, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, emailTriage, user as userTable } from "@alfred/db/schemas";
import { selfSenderEmail } from "@alfred/integrations/google";
import { and, eq, inArray, or, sql } from "drizzle-orm";

/** CLI list parser shared by `--emails` / `--aliases`. */
function parseListFlag(flag: string, fallback: string): string[] {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  const raw = arg ? arg.slice(`${flag}=`.length) : fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseListFlag("--emails", "yashgouravkar@gmail.com");
// Historical Alfred send-from aliases the CURRENT `RESEND_FROM_EMAIL` no longer
// matches. `yash@croisillies.xyz` is the envelope the 05-21 → 06-01 briefings on
// the personal account shipped from (issue #266 evidence).
const ALIAS_INPUT = parseListFlag("--aliases", "yash@croisillies.xyz");
const COMMIT = process.argv.includes("--commit");

async function processUser(
  u: { userId: string; email: string },
  selfAddrs: Set<string>,
): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const addrList = [...selfAddrs];
  // Candidate self-docs: coarse substring filter on `metadata.from` (OR across
  // every self address), then an EXACT parsed-address match — the LIKE alone
  // over-matches display text, and this delete is destructive.
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

  // Classify each candidate thread PURE (every message self-authored) vs MIXED
  // (also carries a real inbound message), using the same exact-address set.
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

  // Only delete self-docs safe to remove: those in a purely-self thread (whose
  // triage row we also delete), or standalone (no thread → no triage to orphan).
  // Self-docs in a MIXED thread are skipped entirely (see header).
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

  // Build the self-set: the CURRENT send address (so this is a superset of the
  // #211 pass and stays idempotent) ∪ the historical aliases. Each alias is run
  // through the SAME parser the runtime guard uses, so the exact-match set below
  // is normalized identically.
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

/**
 * Dry-run triage RE-CATEGORIZE (2026-06-22) — READ-ONLY, prod-runnable.
 *
 * Re-classifies the newest document behind each recent auto-authored
 * `email_triage` row with the CURRENT prompt and diffs the NEW category against
 * the stored one. Unlike
 * `dry-run-triage-backfill.ts` (which walks agent TODOs and is `tsx`-only), this
 * walks the triage rows themselves and reports a category transition matrix —
 * the before/after view for a rubric change (e.g. the rule-8a social-network
 * → fyi flip). It writes NOTHING to `email_triage`/`todos` (it does emit an
 * `api_call_log` cost row per classify — cost attribution, not state).
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/dry-runs/dry-run-triage-recategorize-committed.js` — the prod image
 * has no `tsx`/loose `@alfred/*` sources. Because it re-classifies with whatever
 * prompt is in the running image, run it AFTER deploying the new prompt.
 *
 *   # how many threads per mailbox (default 60):
 *   RECAT_LIMIT=80 node dist/scripts/dry-runs/dry-run-triage-recategorize-committed.js
 */
import {
  assembleObservations,
  classifyEmail,
  closeConnections,
  closeRedis,
  extractSenderContext,
  getSenderPrior,
  getThreadState,
  isKnownContact,
  loadTriageContext,
  resolveSenderKind,
  resolveSenderRelationship,
  senderKeyFor,
  warmPool,
} from "@alfred/api";
import { toMessage, toStringArray } from "@alfred/contracts";
import { db } from "@alfred/db";
import { emailTriage, user as userTable } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

/** Mailboxes to sample. */
const TARGET_EMAILS = ["yash.k@oliv.ai", "yashgouravkar@gmail.com"];
const RECAT_LIMIT = Number(process.env.RECAT_LIMIT) || 60;

function metaStr(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

interface TargetUser {
  userId: string;
  email: string;
}

async function processUser(u: TargetUser): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const rows = await db()
    .select({
      oldCategory: emailTriage.category,
      documentId: emailTriage.documentId,
      threadId: emailTriage.sourceThreadId,
    })
    .from(emailTriage)
    .where(
      and(
        eq(emailTriage.userId, u.userId),
        eq(emailTriage.source, "auto"),
        isNotNull(emailTriage.documentId),
      ),
    )
    .orderBy(desc(emailTriage.classifiedAt))
    .limit(RECAT_LIMIT);

  // old→new transition tally; `changed` keeps the human-readable diffs.
  const transitions = new Map<string, number>();
  const changed: string[] = [];
  let scored = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.documentId) {
      skipped++;
      continue;
    }
    const ctxData = await loadTriageContext(row.documentId, u.userId);
    if (!ctxData) {
      skipped++;
      continue;
    }

    const scResult = extractSenderContext({
      fromHeader: metaStr(ctxData.document.metadata, "from"),
      subject: ctxData.document.title,
      body: ctxData.document.content,
    });
    const senderContext = scResult.context;
    const senderKey = senderKeyFor(senderContext, scResult.senderAddress);
    const meta = ctxData.document.metadata;
    const labelIds = toStringArray(meta.labelIds);
    const isHumanSender = senderContext.effectiveAuthor === "person";

    const [senderPrior, thread, senderKind] = await Promise.all([
      senderKey ? getSenderPrior(u.userId, senderKey).catch(() => null) : Promise.resolve(null),
      row.threadId
        ? getThreadState({
            userId: u.userId,
            sourceThreadId: row.threadId,
            excludeDocumentId: row.documentId,
          }).catch(() => ({
            lastUserReplyAt: null,
            newestDirection: null,
            messageCount: 0,
            recentMessages: [],
          }))
        : Promise.resolve({
            lastUserReplyAt: null,
            newestDirection: null,
            messageCount: 0,
            recentMessages: [],
          }),
      resolveSenderKind(u.userId, scResult.senderAddress),
    ]);
    const usePersonTreatment = isHumanSender && senderKind == null;
    const [knownContact, senderRelationship] = await Promise.all([
      usePersonTreatment && scResult.senderAddress
        ? isKnownContact(u.userId, scResult.senderAddress).catch(() => false)
        : Promise.resolve(false),
      resolveSenderRelationship({
        userId: u.userId,
        senderAddress: scResult.senderAddress,
        isHumanSender: usePersonTreatment,
      }).catch(() => null),
    ]);

    const signalText = [
      metaStr(meta, "from"),
      metaStr(meta, "to"),
      metaStr(meta, "cc"),
      metaStr(meta, "snippet"),
      ctxData.document.title,
      ctxData.document.content,
      ...labelIds,
    ]
      .filter(Boolean)
      .join("\n");

    const observations = assembleObservations({
      senderKey,
      senderPrior,
      persona: ctxData.persona,
      thread,
      knownContact,
      senderRelationship,
      senderKind,
      labelIds,
      signalText,
    });

    let newCategory: string;
    try {
      const { classification } = await classifyEmail({
        userId: u.userId,
        document: {
          id: ctxData.document.id,
          title: ctxData.document.title,
          content: ctxData.document.content,
          authoredAt: ctxData.document.authoredAt,
          metadata: ctxData.document.metadata,
        },
        senderContext,
        observations,
        identity: ctxData.identity,
      });
      newCategory = classification.category;
    } catch (err) {
      console.log(`  ! classify error (skipped): ${toMessage(err)}`);
      skipped++;
      continue;
    }

    scored++;
    const oldCategory = row.oldCategory;
    const key = `${oldCategory} → ${newCategory}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
    if (oldCategory !== newCategory) {
      const from = metaStr(meta, "from") ?? "?";
      changed.push(`  ${key} | ${from} | ${(ctxData.document.title ?? "").slice(0, 60)}`);
    }
  }

  console.log(`  scored ${scored}, skipped ${skipped} (no local doc / classify error)`);
  console.log(`\n  -- category transitions (old → new) --`);
  for (const [k, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    const mark = k.split(" → ")[0] === k.split(" → ")[1] ? "   " : " * ";
    console.log(`  ${mark}${n}\t${k}`);
  }
  if (changed.length) {
    console.log(`\n  -- changed rows (${changed.length}) --`);
    for (const line of changed) console.log(line);
  }
}

async function main() {
  await warmPool();
  console.log(
    `# Dry-run re-categorize — READ-ONLY | auto rows only | limit=${RECAT_LIMIT}/mailbox`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((x) => x.email));
  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
  }

  for (const u of users) await processUser(u);
  console.log("\n# done (nothing written)");
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

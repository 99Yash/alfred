/**
 * Read-only: re-classify recent auto `email_triage` rows with the current prompt and
 * print an old-to-new category matrix. Writes no triage or todo state, but each
 * classify logs an `api_call_log` cost row.
 *
 * Runs on prod (bundled, no `tsx` in the image). It uses the prompt in the running
 * image, so deploy the new prompt first.
 *
 *   # how many threads per mailbox (default 60):
 *   RECAT_LIMIT=80 node dist/scripts/dry-runs/dry-run-triage-recategorize-committed.js
 *   # or name the threads (the preview for `repair-triage-sender-miss-committed.ts`):
 *   RECAT_THREAD_IDS=19a1b2c3d4e5f6a7,19b2c3d4e5f6a7b8 \
 *     node dist/scripts/dry-runs/dry-run-triage-recategorize-committed.js
 */
import type { ClassifyAudit } from "@alfred/assistant/triage";
import {
  assembleObservations,
  classifyEmail,
  extractSenderContext,
  getSenderPrior,
  getThreadState,
  isKnownContact,
  loadTriageContext,
  resolveSenderKind,
  resolveSenderRelationship,
  senderKeyFor,
} from "@alfred/assistant/triage";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { emailTriage, user as userTable } from "@alfred/db/schemas";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

/** Mailboxes to sample. */
const TARGET_EMAILS = ["yash.k@oliv.ai", "yashgouravkar@gmail.com"];

const RECAT_LIMIT = Number(process.env.RECAT_LIMIT) || 60;

/** Named thread ids. When set, they replace the `RECAT_LIMIT` window, inside `TARGET_EMAILS` only. */
const RECAT_THREAD_IDS = (process.env.RECAT_THREAD_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

interface TargetUser {
  userId: string;
  email: string;
}

/**
 * Name the mechanism that moved the category. `model` tags only a floor that moved
 * the answer, so add the audit fields. Print every tag; never substring-test them,
 * because `+2pass_failed` contains `+2pass`.
 */
function describeMechanism(model: string, audit: ClassifyAudit): string {
  const tags = model.split("+").slice(1);
  const parts = tags.map((tag) => `+${tag}`);

  if (audit.conflict) parts.push(`conflict=${audit.conflict.kind}`);

  if (audit.secondPassFailure) parts.push("2pass=threw");

  if (audit.floors.spam.outcome) parts.push(`spam=${audit.floors.spam.outcome}`);

  return parts.length > 0 ? parts.join(" ") : "model";
}

/** Re-classify this mailbox's rows, print the diff, and return the thread ids it classified. */
async function processUser(u: TargetUser): Promise<Set<string>> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const scope = and(
    eq(emailTriage.userId, u.userId),
    eq(emailTriage.source, "auto"),
    isNotNull(emailTriage.documentId),
    RECAT_THREAD_IDS.length > 0 ? inArray(emailTriage.sourceThreadId, RECAT_THREAD_IDS) : undefined,
  );

  const rows = await db()
    .select({
      oldCategory: emailTriage.category,
      documentId: emailTriage.documentId,
      threadId: emailTriage.sourceThreadId,
    })
    .from(emailTriage)
    .where(scope)
    .orderBy(desc(emailTriage.classifiedAt))
    // A named-thread run must not be truncated by the window's limit.
    .limit(RECAT_THREAD_IDS.length > 0 ? RECAT_THREAD_IDS.length : RECAT_LIMIT);

  const previewed = new Set<string>();
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
      fromHeader: ctxData.document.metadata.from ?? null,
      subject: ctxData.document.title,
      body: ctxData.document.content,
    });

    const senderContext = scResult.context;
    const senderKey = senderKeyFor(senderContext, scResult.senderAddress);
    const meta = ctxData.document.metadata;
    const labelIds = meta.labelIds ?? [];
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

    const [knownContact, relationship] = await Promise.all([
      usePersonTreatment && scResult.senderAddress
        ? isKnownContact(u.userId, scResult.senderAddress).catch(() => false)
        : Promise.resolve(false),
      resolveSenderRelationship({
        userId: u.userId,
        senderAddress: scResult.senderAddress,
        isHumanSender: usePersonTreatment,
      }).catch(() => ({ descriptor: null, isColdContact: false })),
    ]);

    const signalText = [
      meta.from,
      meta.to,
      meta.cc,
      meta.snippet,
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
      senderRelationship: relationship.descriptor,
      senderRelationshipIsCold: relationship.isColdContact,
      senderKind,
      labelIds,
      signalText,
    });

    let newCategory: string;
    let mechanism: string;

    try {
      const { classification, model, audit } = await classifyEmail({
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
      mechanism = describeMechanism(model, audit);
    } catch (err) {
      console.log(`  ! classify error (skipped): ${toMessage(err)}`);
      skipped++;
      continue;
    }

    scored++;
    previewed.add(row.threadId);
    const oldCategory = row.oldCategory;
    const key = `${oldCategory} → ${newCategory}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);

    if (oldCategory !== newCategory) {
      const from = meta.from ?? "?";

      changed.push(
        `  ${key} | ${mechanism} | ${from} | ${(ctxData.document.title ?? "").slice(0, 60)}`,
      );
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

  return previewed;
}

/**
 * Name each requested thread this preview skipped, and why. A silent drop would
 * look like "no change" to the human who then approves the repair.
 */
async function reportUncoveredThreads(previewed: Set<string>): Promise<void> {
  const uncovered = RECAT_THREAD_IDS.filter((id) => !previewed.has(id));

  console.log(`\n# previewed ${previewed.size} of ${RECAT_THREAD_IDS.length} requested thread(s)`);

  if (uncovered.length === 0) return;

  // Unscoped on purpose: it must see the rows the filters above hid.
  const rows = await db()
    .select({
      threadId: emailTriage.sourceThreadId,
      source: emailTriage.source,
      documentId: emailTriage.documentId,
      email: userTable.email,
    })
    .from(emailTriage)
    .innerJoin(userTable, eq(userTable.id, emailTriage.userId))
    .where(inArray(emailTriage.sourceThreadId, uncovered));

  const byThread = new Map<string, (typeof rows)[number][]>();

  for (const row of rows) {
    const found = byThread.get(row.threadId) ?? [];

    found.push(row);
    byThread.set(row.threadId, found);
  }

  for (const threadId of uncovered) {
    const found = byThread.get(threadId) ?? [];

    if (found.length === 0) {
      console.log(`  ! ${threadId}: NOT PREVIEWED — no email_triage row in any mailbox`);
      continue;
    }

    for (const row of found) {
      const reason = !TARGET_EMAILS.includes(row.email)
        ? `its mailbox ${row.email} is outside TARGET_EMAILS`
        : row.source !== "auto"
          ? `source='${row.source}' — this preview reads auto rows only`
          : !row.documentId
            ? `the row names no document_id`
            : `it was selected, then dropped inside the classify loop — either ` +
              `loadTriageContext found no live document behind document_id (a purge, which ` +
              `../repairs/repair-triage-sender-miss-committed.ts names loudly), or classifyEmail ` +
              `threw. Neither drop prints a thread id; only the aggregate 'scored N, skipped M' ` +
              `line for ${row.email} above counts it`;

      console.log(`  ! ${threadId}: NOT PREVIEWED — ${reason}`);
    }
  }
}

async function main() {
  await warmPool();
  console.log(
    `# Dry-run re-categorize — READ-ONLY | auto rows only | ` +
      (RECAT_THREAD_IDS.length > 0
        ? `scoped to ${RECAT_THREAD_IDS.length} named thread(s)`
        : `limit=${RECAT_LIMIT}/mailbox`),
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((x) => x.email));

  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
  }

  const previewed = new Set<string>();

  for (const u of users) {
    for (const threadId of await processUser(u)) previewed.add(threadId);
  }

  if (RECAT_THREAD_IDS.length > 0) await reportUncoveredThreads(previewed);

  console.log("\n# done (nothing written)");
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

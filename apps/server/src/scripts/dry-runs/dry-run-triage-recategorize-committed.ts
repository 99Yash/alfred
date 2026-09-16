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
 *   # or name the threads instead of taking a window — the preview a thread-scoped
 *   # repair (`../repairs/repair-triage-sender-miss-committed.ts`) runs before it commits:
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

/**
 * Named Gmail thread ids. When set, these REPLACE the `RECAT_LIMIT` recency
 * window: the run scopes to exactly these threads in whichever mailbox owns
 * them. This is the preview half of a thread-scoped repair — see
 * `../repairs/repair-triage-sender-miss-committed.ts`, which enqueues the real
 * workflow for the same ids and must never do so unpreviewed.
 *
 * The `source = 'auto'` filter below still applies, so a user-overridden thread
 * named here drops out of the re-classify loop. It does NOT drop out of the
 * report: {@link reportUncoveredThreads} names every requested id this run did
 * not re-classify, and why. A silent drop here would be read as "no change".
 */
const RECAT_THREAD_IDS = (process.env.RECAT_THREAD_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

interface TargetUser {
  userId: string;
  email: string;
}

/**
 * Name WHICH mechanism moved the answer, not just that it moved.
 *
 * `model` carries one `+tag` per deterministic floor that MOVED the category,
 * plus the second-pass tag. That makes it incomplete, not authoritative: a floor
 * that ran and held the answer emits no tag (`floors/index.ts:138-175` tags only
 * the moving arm), which is exactly the spam floor's `held_demand_lane` path.
 * `ClassifyAudit.floors` is the authoritative source. This function reads it for
 * the spam floor only; item 32 owns reading it by key for all four floors.
 *
 * This function TESTS NO TAG: it splits `model` on `+` and re-prints every tag it
 * finds. Enumerating is deliberate. A tag test would have to match whole tags, because
 * `'+2pass_failed'` CONTAINS `'+2pass'` and a substring test therefore reads a
 * failed re-check as a successful one. Printing the split avoids the question
 * and keeps a tag this function has never heard of visible in the output.
 *
 * The audit fields beside it say what the tags cannot: `conflict` names the net
 * that asked for a second pass even when the second pass changed nothing, and
 * `spamFloorOutcome` distinguishes the spam floor holding a demand lane (the
 * softened path, no tag) from the floor being inert.
 */
function describeMechanism(model: string, audit: ClassifyAudit): string {
  const tags = model.split("+").slice(1);
  const parts = tags.map((tag) => `+${tag}`);

  if (audit.conflict) parts.push(`conflict=${audit.conflict.kind}`);

  if (audit.secondPassFailure) parts.push("2pass=threw");

  if (audit.floors.spam.outcome) parts.push(`spam=${audit.floors.spam.outcome}`);

  return parts.length > 0 ? parts.join(" ") : "model";
}

/**
 * Re-classify this mailbox's rows and print the diff. Returns the thread ids it
 * actually re-classified, so {@link reportUncoveredThreads} can name every
 * requested id that never reached a classify call.
 */
async function processUser(u: TargetUser): Promise<Set<string>> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const scope = and(
    eq(emailTriage.userId, u.userId),
    eq(emailTriage.source, "auto"),
    isNotNull(emailTriage.documentId),
    // Named threads replace the window; no ids means the whole recency window.
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

  // old→new transition tally; `changed` keeps the human-readable diffs.
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
 * Name every requested thread id this preview did not re-classify, and say which
 * filter dropped it.
 *
 * The operator procedure for a sender-miss repair runs THIS preview, shows it to
 * the human, and then runs `../repairs/repair-triage-sender-miss-committed.ts`
 * with `--commit`, which enqueues the real workflow and ends in a live Gmail
 * label write. So a requested id the preview drops in silence gets approved on
 * the strength of a preview that never mentioned it. The repair script prints a
 * loud line for every id it cannot run; the preview half must do the same, or
 * the two halves of one procedure disagree about what the human saw.
 */
async function reportUncoveredThreads(previewed: Set<string>): Promise<void> {
  const uncovered = RECAT_THREAD_IDS.filter((id) => !previewed.has(id));

  console.log(`\n# previewed ${previewed.size} of ${RECAT_THREAD_IDS.length} requested thread(s)`);

  if (uncovered.length === 0) return;

  // Deliberately UNSCOPED — no user, no `source = 'auto'`, no document filter.
  // The point is to name which of the scope filters above dropped the id, so
  // this read must see the rows those filters hid.
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });

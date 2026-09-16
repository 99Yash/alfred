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
 * named here drops out on its own — the same exclusion the repair script makes
 * explicit.
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
 * `model` carries one `+tag` per deterministic floor that fired plus the
 * second-pass tag, so it is the authoritative attribution. Split it on `+` and
 * match WHOLE tags: `'+2pass_failed'` CONTAINS `'+2pass'`, so a substring test
 * reads a failed re-check as a successful one.
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

async function processUser(u: TargetUser): Promise<void> {
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
    await closeScriptResources();
  });

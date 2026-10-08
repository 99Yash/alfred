/**
 * Reject proposed `relationship:<email>` junk (#493). It uses the shared classifier
 * `isUninformativeRelationshipFact`, so "junk" has one definition.
 * Junk: the edge points at a service or no-reply sender, or the value is empty.
 * `rejectFact` also records the signature, so nothing re-proposes it.
 *
 * Only proposed relationship rows. Confirmed facts stay. The #492 write guard must
 * be live first, or ingest re-creates the rows.
 *
 * Dry by default. A dry run without `--emails` surveys all users. `--commit` requires
 * `--emails=...`. Idempotent.
 *
 *   # preview one account (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-relationship-junk-committed.js --emails=a@x.com
 *   # preview every account (writes nothing):
 *   node dist/scripts/backfills/backfill-purge-relationship-junk-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-purge-relationship-junk-committed.js --emails=a@x.com --commit
 */
import { isUninformativeRelationshipFact, rejectFact } from "@alfred/assistant/knowledge";
import {
  isServiceSender,
  isUninformativeRelationshipValue,
} from "@alfred/assistant/knowledge/internal";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { RELATIONSHIP_FACT_PREFIX, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user as userTable, userFacts } from "@alfred/db/schemas";
import { and, eq, gt, inArray, isNull, like, or } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

const VERBOSE_VALUES = process.argv.includes("--verbose-values");

/** Max sample rows to print. Counts stay exact. */
const SAMPLE_LIMIT = 50;

function parseTargetEmails(): string[] | null {
  const flag = process.argv.find((arg) => arg.startsWith("--emails="));

  if (COMMIT && !flag) {
    throw new Error("--emails=a@x.com must be set explicitly when using --commit");
  }

  if (!flag) return null;

  return flag
    .slice("--emails=".length)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseTargetEmails();

type ProposedRelRow = {
  id: string;
  key: string;
  value: unknown;
};

/** Which junk shapes a row matched. */
function junkReason(key: string, value: unknown): string {
  const reasons: string[] = [];

  const email = key.startsWith(RELATIONSHIP_FACT_PREFIX)
    ? key.slice(RELATIONSHIP_FACT_PREFIX.length).trim()
    : "";

  if (email && isServiceSender(email)) reasons.push("service_sender");

  if (isUninformativeRelationshipValue(value)) reasons.push("empty_value");

  return reasons.join("+") || "relationship_junk";
}

/** Show the domain, not the full address. */
function maskRelKey(key: string): string {
  if (VERBOSE_VALUES) return key;
  const email = key.slice(RELATIONSHIP_FACT_PREFIX.length);
  const at = email.indexOf("@");

  if (at <= 0) return `${RELATIONSHIP_FACT_PREFIX}[redacted]`;
  const head = email.slice(0, 1);

  return `${RELATIONSHIP_FACT_PREFIX}${head}…@${email.slice(at + 1)}`;
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);

  const masked = VERBOSE_VALUES
    ? s
    : s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");

  return masked.length > 48 ? `${masked.slice(0, 47)}…` : masked;
}

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);
  const now = new Date();

  const rows: ProposedRelRow[] = await db()
    .select({
      id: userFacts.id,
      key: userFacts.key,
      value: userFacts.value,
    })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, u.userId),
        eq(userFacts.status, "proposed"),
        like(userFacts.key, `${RELATIONSHIP_FACT_PREFIX}%`),
        or(isNull(userFacts.validUntil), gt(userFacts.validUntil, now)),
      ),
    );

  // SQL narrows to the namespace; the classifier decides.
  const junk = rows.filter((r) => isUninformativeRelationshipFact(r.key, r.value));
  const kept = rows.length - junk.length;

  console.log(`  proposed relationship rows: ${rows.length} | junk ${junk.length} | keep ${kept}`);

  if (junk.length) {
    const byReason = new Map<string, number>();

    for (const r of junk) {
      const reason = junkReason(r.key, r.value);
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }

    console.log(`  PURGE by reason:`);

    for (const [reason, n] of [...byReason.entries()].sort()) console.log(`    ${reason}: ${n}`);

    console.log(`  samples (${Math.min(junk.length, SAMPLE_LIMIT)} of ${junk.length}):`);

    for (const r of junk.slice(0, SAMPLE_LIMIT)) {
      console.log(`    ${maskRelKey(r.key)} = ${preview(r.value)} [${junkReason(r.key, r.value)}]`);
    }

    if (junk.length > SAMPLE_LIMIT) console.log(`    …and ${junk.length - SAMPLE_LIMIT} more`);
  }

  if (!COMMIT) {
    console.log(`\n  DRY — nothing written. Re-run with --emails=… --commit to apply.`);

    return;
  }

  let rejected = 0;

  for (const r of junk) {
    const res = await rejectFact({
      factId: r.id,
      userId: u.userId,
      reason: {
        via: "backfill-purge-relationship-junk",
        issue: 493,
        key: r.key,
        reason: junkReason(r.key, r.value),
      },
    });

    if (res) rejected++;
  }

  console.log(`\n  COMMITTED — purged ${rejected}/${junk.length}.`);
}

async function main() {
  await warmPool();
  console.log(
    `# Purge proposed relationship junk (#493) — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `values=${VERBOSE_VALUES ? "shown" : "masked"} | ` +
      `targets=${TARGET_EMAILS ? TARGET_EMAILS.join(", ") : "ALL USERS"}`,
  );

  const users = await (TARGET_EMAILS
    ? db()
        .select({ userId: userTable.id, email: userTable.email })
        .from(userTable)
        .where(inArray(userTable.email, TARGET_EMAILS))
    : db().select({ userId: userTable.id, email: userTable.email }).from(userTable));

  if (TARGET_EMAILS) {
    const found = new Set(users.map((u) => u.email));
    const missing = TARGET_EMAILS.filter((e) => !found.has(e));

    if (missing.length > 0) {
      const message = `no user row for target email(s): ${missing.join(", ")}`;

      if (COMMIT) throw new Error(message);
      console.log(`! ${message} — skipping`);
    }
  }

  for (const u of users) await processUser(u);

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

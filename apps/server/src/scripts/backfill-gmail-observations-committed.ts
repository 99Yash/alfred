/**
 * COMMITTED Gmail observation backfill (user-model P1, issue #218 — PR D).
 *
 * Reduces already-stored Gmail `documents` into ADR-0067 `email_message`
 * observations. This script does not call Gmail and does not touch mailbox
 * labels; it is a replay over local `documents` only. Writes route through the
 * user-model observation append helper, which validates the reducer output and
 * owns family supersession / CAS retry.
 *
 * SAFETY: dry by default. `--commit` is required to write observations.
 *
 *   # preview personal mailbox:
 *   node dist/scripts/backfill-gmail-observations-committed.js --emails=yashgouravkar@gmail.com
 *   # commit every connected mailbox, oldest 5000 docs by authoredAt:
 *   node dist/scripts/backfill-gmail-observations-committed.js --all-connected --commit
 *   # force reprocess existing families after reducer changes:
 *   node dist/scripts/backfill-gmail-observations-committed.js --emails=yashgouravkar@gmail.com --force --commit
 */
import {
  appendObservationFamilyMember,
  closeConnections,
  closeRedis,
  reduceGmailDocument,
  warmPool,
  type GmailDocumentForReduction,
} from "@alfred/api";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  documents,
  integrationCredentials,
  observationFamilyHeads,
  user as userTable,
} from "@alfred/db/schemas";
import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");
const ALL_CONNECTED = process.argv.includes("--all-connected");
const FORCE = process.argv.includes("--force");
const DEFAULT_LIMIT = 5000;

function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parseEmails(): string[] {
  const raw = flagValue("emails");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = flagValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function parseDateFlag(name: string): Date | null {
  const raw = flagValue(name);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--${name} must be a valid date/time, got: ${raw}`);
  }
  return date;
}

interface TargetUser {
  userId: string;
  email: string;
}

async function resolveTargets(emails: readonly string[]): Promise<TargetUser[]> {
  if (ALL_CONNECTED) {
    const rows = await db()
      .select({
        userId: userTable.id,
        email: userTable.email,
      })
      .from(integrationCredentials)
      .innerJoin(userTable, eq(userTable.id, integrationCredentials.userId))
      .where(
        and(
          eq(integrationCredentials.provider, "google"),
          eq(integrationCredentials.status, "active"),
        ),
      )
      .groupBy(userTable.id, userTable.email)
      .orderBy(asc(userTable.email));
    return rows;
  }

  return db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, [...emails]))
    .orderBy(asc(userTable.email));
}

async function hasObservationFamily(userId: string, familyKey: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: observationFamilyHeads.id })
    .from(observationFamilyHeads)
    .where(
      and(
        eq(observationFamilyHeads.userId, userId),
        eq(observationFamilyHeads.familyKey, familyKey),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function loadDocuments(args: {
  userId: string;
  since: Date | null;
  until: Date | null;
  limit: number;
}): Promise<GmailDocumentForReduction[]> {
  const conds: SQL[] = [eq(documents.userId, args.userId), eq(documents.source, "gmail")];
  if (args.since) conds.push(gte(documents.authoredAt, args.since));
  if (args.until) conds.push(lte(documents.authoredAt, args.until));

  return db()
    .select({
      id: documents.id,
      userId: documents.userId,
      sourceId: documents.sourceId,
      sourceThreadId: documents.sourceThreadId,
      accountId: documents.accountId,
      title: documents.title,
      authoredAt: documents.authoredAt,
      raw: documents.raw,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(...conds))
    .orderBy(sql`${documents.authoredAt} asc nulls last`, asc(documents.id))
    .limit(args.limit);
}

async function processUser(args: {
  target: TargetUser;
  since: Date | null;
  until: Date | null;
  limit: number;
}): Promise<void> {
  const docs = await loadDocuments({
    userId: args.target.userId,
    since: args.since,
    until: args.until,
    limit: args.limit,
  });

  console.log(`\n=== ${args.target.email} (user=${args.target.userId}) ===`);
  console.log(`  gmail documents: ${docs.length}`);

  const stats = {
    reduced: 0,
    inserted: 0,
    deduped: 0,
    wouldWrite: 0,
    skippedExisting: 0,
    skippedReducer: 0,
    warnings: 0,
    errors: 0,
  };

  for (const doc of docs) {
    try {
      const reduced = reduceGmailDocument(doc);
      for (const issue of reduced.issues) {
        if (issue.severity === "skip") stats.skippedReducer++;
        else stats.warnings++;
        console.log(
          `  ${issue.severity.toUpperCase()} doc=${doc.id} ${issue.code}: ${issue.message}`,
        );
      }
      if (reduced.observations.length === 0) continue;

      stats.reduced += reduced.observations.length;
      for (const observation of reduced.observations) {
        if (!FORCE && (await hasObservationFamily(observation.userId, observation.familyKey))) {
          stats.skippedExisting++;
          continue;
        }

        if (!COMMIT) {
          stats.wouldWrite++;
          continue;
        }
        const result = await appendObservationFamilyMember(observation);
        if (result.status === "deduped") stats.deduped++;
        else stats.inserted++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`  ERROR doc=${doc.id}: ${toMessage(err)}`);
    }
  }

  console.log(
    `  ${COMMIT ? "COMMITTED" : "DRY"} — reduced=${stats.reduced} inserted=${stats.inserted} ` +
      `deduped=${stats.deduped} would_write=${stats.wouldWrite} ` +
      `skipped_existing=${stats.skippedExisting} ` +
      `skipped_reducer=${stats.skippedReducer} warnings=${stats.warnings} errors=${stats.errors}`,
  );
}

async function main() {
  const emails = parseEmails();
  if (!ALL_CONNECTED && emails.length === 0) {
    throw new Error("specify --emails=a@x.com,b@y.com or --all-connected");
  }
  if (ALL_CONNECTED && emails.length > 0) {
    throw new Error("--emails and --all-connected are mutually exclusive");
  }

  const since = parseDateFlag("since");
  const until = parseDateFlag("until");
  if (since && until && since > until) {
    throw new Error("--since must be before --until");
  }
  const limit = parsePositiveInt("limit", DEFAULT_LIMIT);

  await warmPool();
  console.log(
    `# Gmail observation backfill — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `force=${FORCE} limit=${limit} since=${since?.toISOString() ?? "none"} ` +
      `until=${until?.toISOString() ?? "none"} | ` +
      `target=${ALL_CONNECTED ? "all-connected" : emails.join(", ")}`,
  );

  const targets = await resolveTargets(emails);
  if (!ALL_CONNECTED) {
    const found = new Set(targets.map((t) => t.email));
    for (const email of emails) {
      if (!found.has(email)) console.log(`! no user row for ${email}`);
    }
  }
  if (targets.length === 0) {
    console.log("no targets matched — nothing to do");
    return;
  }

  for (const target of targets) await processUser({ target, since, until, limit });

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

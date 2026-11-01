/**
 * Replay stored GitHub deliveries into the activity record (ADR-0118 slice 2), and report the
 * record and its coverage for one day.
 *
 * The bodies come from `documents.raw`. A credential cascade deleted the GitHub receipts from
 * before 2026-10-28, but their documents remain. The reducer is idempotent: a family key names one
 * act, and an equal evidence hash dedups. Dry by default; `--commit` appends (additive only).
 *
 *   # preview (writes nothing):
 *   tsx src/scripts/backfills/backfill-github-activity-committed.ts
 *   # commit:
 *   tsx src/scripts/backfills/backfill-github-activity-committed.ts --commit
 *   # the record and coverage of one local day, for each user with GitHub documents:
 *   tsx src/scripts/backfills/backfill-github-activity-committed.ts --report 2026-10-27
 */
import {
  pageGithubActivityDocuments,
  readActivityCoverage,
  readGithubSelf,
  reduceGithubActivity,
} from "@alfred/assistant/connections";
import { appendObservationFamilyMember, recallLatestByKey } from "@alfred/assistant/knowledge";
import { settings } from "@alfred/assistant/settings";
import { inZone, parseLocalDateKey } from "@alfred/assistant/time";
import { activityPayloadSchema, toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { documents, observationFamilyHeads, observations } from "@alfred/db/schemas";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

const REPORT_INDEX = process.argv.indexOf("--report");

const REPORT_DAY = REPORT_INDEX === -1 ? null : (process.argv[REPORT_INDEX + 1] ?? null);

const PAGE_SIZE = 500;

type GithubSelf = Awaited<ReturnType<typeof readGithubSelf>>;

async function selfOf(userId: string, cache: Map<string, GithubSelf>): Promise<GithubSelf> {
  const cached = cache.get(userId);

  if (cached) return cached;
  const fact = await recallLatestByKey(userId, "github_username");
  const self = await readGithubSelf(userId, fact?.value);
  cache.set(userId, self);

  return self;
}

async function replay(): Promise<void> {
  console.log(`# GitHub activity replay: mode=${COMMIT ? "COMMIT" : "DRY"}`);
  const selves = new Map<string, GithubSelf>();
  const byVerb = new Map<string, number>();
  let read = 0;
  let rows = 0;
  let inserted = 0;
  let afterId: string | null = null;

  do {
    const page = await pageGithubActivityDocuments({ afterId, limit: PAGE_SIZE });
    afterId = page.nextId;

    for (const doc of page.documents) {
      read++;
      const row = reduceGithubActivity(doc, await selfOf(doc.userId, selves));

      if (!row) continue;
      rows++;
      const payload = activityPayloadSchema.parse(row.payload);
      const subject = row.subjectIdentity.kind === "user" ? "user" : "other";
      const key = `${payload.verb} by ${subject}`;
      byVerb.set(key, (byVerb.get(key) ?? 0) + 1);

      if (COMMIT && (await appendObservationFamilyMember(row)).status === "inserted") inserted++;
    }
  } while (afterId);

  console.log(`  ${read} candidate documents, ${rows} activity rows`);

  for (const [key, count] of [...byVerb].toSorted(([a], [b]) => a.localeCompare(b))) {
    console.log(`    ${key}: ${count}`);
  }

  console.log(COMMIT ? `  inserted ${inserted} new rows` : "  (pass --commit to append them)");
}

async function report(dayText: string): Promise<void> {
  const day = parseLocalDateKey(dayText);

  const users = await db()
    .selectDistinct({ userId: documents.userId })
    .from(documents)
    .where(eq(documents.source, "github"));

  for (const { userId } of users) {
    const timezone = await settings({ userId }).timezone();
    const zone = inZone(timezone);
    const { start, end } = zone.dayBounds(zone.startOf(day));

    const coverage = await readActivityCoverage({
      userId,
      window: { start, end },
      now: new Date(),
    });

    console.log(`# ${userId} ${day} (${timezone}) [${start.toISOString()}, ${end.toISOString()})`);

    for (const entry of coverage) console.log(`  coverage ${JSON.stringify(entry)}`);

    const record = await db()
      .select({
        occurredAt: observations.occurredAt,
        subject: observations.subjectIdentity,
        object: observations.objectIdentity,
        payload: observations.payload,
      })
      .from(observations)
      // Only the live member of each family, so a superseded row does not print twice.
      .innerJoin(
        observationFamilyHeads,
        eq(observationFamilyHeads.headObservationId, observations.id),
      )
      .where(
        and(
          eq(observations.userId, userId),
          eq(observations.kind, "activity"),
          gte(observations.occurredAt, start),
          lt(observations.occurredAt, end),
        ),
      )
      .orderBy(asc(observations.occurredAt));

    console.log(`  ${record.length} activity rows`);

    for (const row of record) {
      const payload = activityPayloadSchema.parse(row.payload);
      const actor = row.subject.kind === "user" ? "user" : (payload.actorLogin ?? row.subject.kind);
      console.log(
        `    ${row.occurredAt.toISOString()} ${actor} ${payload.verb} ${row.object?.value ?? "-"}`,
      );
    }
  }
}

async function main(): Promise<void> {
  await warmPool();

  if (REPORT_DAY) await report(REPORT_DAY);
  else await replay();
}

try {
  await main();
} catch (e) {
  // Message only: a serialized Error can leak DATABASE_URL.
  console.error(toMessage(e));
  process.exitCode = 1;
} finally {
  await closeScriptResources();
}

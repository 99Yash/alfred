/**
 * Replay stored GitHub deliveries into the activity record (ADR-0118 slice 2), and report the
 * record and its coverage for one day.
 *
 * The bodies come from `documents.raw`. A credential cascade deleted the GitHub receipts from
 * before 2026-10-28, but their documents remain. The reducer is idempotent: a family key names one
 * act, and an equal evidence hash dedups. A merge and the push that GitHub made for it share one
 * family, and the merge stays the head in either order. A second pull request that the same commit
 * merged keeps its row in its own family. The DRY count calls the same head rule on heads that it
 * keeps in memory. Dry by default; `--commit` appends (additive only).
 *
 *   # preview (writes nothing):
 *   tsx src/scripts/backfills/backfill-github-activity-committed.ts
 *   # commit:
 *   tsx src/scripts/backfills/backfill-github-activity-committed.ts --commit
 *   # the record and coverage of one local day, for each user with GitHub documents:
 *   tsx src/scripts/backfills/backfill-github-activity-committed.ts --report 2026-10-27
 */
import {
  type GithubFamilyHead,
  pageGithubActivityDocuments,
  readActivityCoverage,
  readGithubSelf,
  reduceGithubActivity,
} from "@alfred/assistant/connections";
import {
  appendObservationFamilyMember,
  readObservationFamilyHeads,
  recallLatestByKey,
} from "@alfred/assistant/knowledge";
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
  /** The head of each family after the replay, in the fields that the head rule reads. */
  const heads = new Map<string, GithubFamilyHead & { readonly label: string }>();
  let read = 0;
  let rows = 0;
  let inserted = 0;
  let kept = 0;
  let afterId: string | null = null;

  do {
    const page = await pageGithubActivityDocuments({ afterId, limit: PAGE_SIZE });
    afterId = page.nextId;

    for (const doc of page.documents) {
      read++;
      const append = reduceGithubActivity(doc, await selfOf(doc.userId, selves));

      if (!append) continue;
      rows++;
      const { row, keepHead, otherwise } = append;
      const payload = activityPayloadSchema.parse(row.payload);
      const subject = row.subjectIdentity.kind === "user" ? "user" : "other";
      const familyId = `${row.userId} ${row.familyKey}`;
      const head = heads.get(familyId);

      const value = {
        label: `${payload.verb} by ${subject}`,
        payload: row.payload,
        objectIdentity: row.objectIdentity ?? null,
      };

      // The rule that the commit path runs under the family lock.
      if (head && keepHead(head)) {
        if (otherwise) heads.set(`${otherwise.userId} ${otherwise.familyKey}`, value);
        else kept++;
      } else {
        heads.set(familyId, value);
      }

      if (COMMIT) {
        const result = await appendObservationFamilyMember(row, { keepHead });

        if (result.status === "inserted") inserted++;

        if (result.status === "kept_head" && otherwise) {
          if ((await appendObservationFamilyMember(otherwise)).status === "inserted") inserted++;
        }
      }
    }
  } while (afterId);

  const byVerb = new Map<string, number>();

  for (const { label } of heads.values()) byVerb.set(label, (byVerb.get(label) ?? 0) + 1);

  console.log(`  ${read} candidate documents, ${rows} activity rows, ${heads.size} family heads`);
  console.log(`  ${kept} merge pushes kept out by their merge`);

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
      readFamilyHeads: readObservationFamilyHeads,
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

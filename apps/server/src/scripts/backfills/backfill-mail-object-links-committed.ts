/**
 * Write the `gmail/email_interpretation` link of each received Gmail message from the last 30 days
 * (ADR-0120 slice 1). Triage writes the same row for each new mail; this covers the mail that
 * arrived before. The script calls the triage writer, so the keys, the sender gate, and the
 * resolution are the live ones. The writer is idempotent: the same resolution dedups, and a changed
 * one supersedes the head. Dry by default; `--commit` appends.
 *
 *   # preview (writes nothing):
 *   tsx src/scripts/backfills/backfill-mail-object-links-committed.ts
 *   # commit:
 *   tsx src/scripts/backfills/backfill-mail-object-links-committed.ts --commit
 *   # another window, in days:
 *   tsx src/scripts/backfills/backfill-mail-object-links-committed.ts --days 45
 */
import { recordMailObjectLinks, type MailObjectLinkWrite } from "@alfred/assistant/triage";
import { isSentGmailMetadata, parseGmailDocumentMetadata, toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import { and, asc, eq, gt, gte } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

const DAYS_INDEX = process.argv.indexOf("--days");

const DAYS = DAYS_INDEX === -1 ? 30 : Number(process.argv[DAYS_INDEX + 1]);

const PAGE_SIZE = 200;

async function backfill(): Promise<void> {
  if (!Number.isInteger(DAYS) || DAYS < 1) throw new Error(`--days must be a positive integer`);
  const since = new Date(Date.now() - DAYS * 86_400_000);

  console.log(
    `# Mail object links: mode=${COMMIT ? "COMMIT" : "DRY"} since=${since.toISOString()}`,
  );

  type Outcome = MailObjectLinkWrite["status"] | "sent" | "failed";

  const counts = new Map<Outcome, number>();

  const bump = (key: Outcome) => counts.set(key, (counts.get(key) ?? 0) + 1);

  let resolvedObjects = 0;
  let read = 0;
  let afterId = "";

  for (;;) {
    const page = await db()
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.source, "gmail"),
          gte(documents.ingestedAt, since),
          gt(documents.id, afterId),
        ),
      )
      .orderBy(asc(documents.id))
      .limit(PAGE_SIZE);

    const last = page.at(-1);

    if (!last) break;
    afterId = last.id;

    for (const doc of page) {
      read++;
      const metadata = parseGmailDocumentMetadata(doc.metadata);

      // Triage writes no link for the user's own sent mail, so the backfill writes none either.
      if (isSentGmailMetadata(metadata)) {
        bump("sent");
        continue;
      }

      try {
        const result = await recordMailObjectLinks({
          document: doc,
          sender: metadata.from ?? null,
          commit: COMMIT,
        });

        bump(result.status);

        if ("resolved" in result) resolvedObjects += result.resolved.length;
      } catch (err) {
        bump("failed");
        console.error(`  ${doc.id}: ${toMessage(err)}`);
      }
    }
  }

  console.log(`  ${read} Gmail documents read`);

  for (const [status, count] of [...counts].toSorted(([a], [b]) => a.localeCompare(b))) {
    console.log(`    ${status}: ${count}`);
  }

  console.log(`  ${resolvedObjects} stored things named`);
  console.log(COMMIT ? "  committed" : "  (pass --commit to write the links)");

  if ((counts.get("failed") ?? 0) > 0) process.exitCode = 1;
}

try {
  await warmPool();
  await backfill();
} catch (e) {
  // Message only: a serialized Error can leak DATABASE_URL.
  console.error(toMessage(e));
  process.exitCode = 1;
} finally {
  await closeScriptResources();
}

/**
 * Write the `gmail/email_interpretation` link of each Gmail message from the last 30 days, by mail
 * time (ADR-0120 slice 1). Triage writes the same row for each new mail; this covers the mail that
 * arrived before. The script calls the triage writer, so the keys, the links, and the sender gate
 * are the live ones. It writes a row only for a message with a triage verdict in the run history:
 * that is the mail that triage links, and the verdict is the category of the row. A message with no
 * verdict (triage off, sent mail, an older message in a tagged thread, or no run) is skipped as
 * `no_triage_run`. The append is idempotent: a payload equal to the head dedups, and another
 * payload becomes the head. Dry by default; `--commit` appends.
 *
 *   # preview (writes nothing):
 *   tsx src/scripts/backfills/backfill-mail-object-links-committed.ts
 *   # commit:
 *   tsx src/scripts/backfills/backfill-mail-object-links-committed.ts --commit
 *   # another window, in days:
 *   tsx src/scripts/backfills/backfill-mail-object-links-committed.ts --days 45
 */
import {
  appendMailObjectLink,
  proposeMailObjectLinksBatch,
  readTriageVerdicts,
  type MailObjectLinkInput,
  type MailObjectLinkProposal,
} from "@alfred/assistant/triage";
import { parseGmailDocumentMetadata, toMessage } from "@alfred/contracts";
import { db, warmPool } from "@alfred/db";
import { documents, type Document } from "@alfred/db/schemas";
import { and, asc, eq, gt, gte, isNull, or } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

const DAYS_INDEX = process.argv.indexOf("--days");

const DAYS = DAYS_INDEX === -1 ? 30 : Number(process.argv[DAYS_INDEX + 1]);

const PAGE_SIZE = 200;

type Outcome =
  | Exclude<MailObjectLinkProposal["status"], "link">
  | Awaited<ReturnType<typeof appendMailObjectLink>>
  | "dry"
  | "no_triage_run"
  | "failed";

async function backfill(): Promise<void> {
  if (!Number.isInteger(DAYS) || DAYS < 1) throw new Error(`--days must be a positive integer`);
  const since = new Date(Date.now() - DAYS * 86_400_000);

  console.log(
    `# Mail object links: mode=${COMMIT ? "COMMIT" : "DRY"} since=${since.toISOString()}`,
  );

  const counts = new Map<Outcome, number>();

  const bump = (key: Outcome, by = 1) => counts.set(key, (counts.get(key) ?? 0) + by);

  let resolvedObjects = 0;
  let read = 0;
  let afterId = "";

  for (;;) {
    // The mail clock, as the row's `occurredAt`: `authoredAt`, else the ingest time. A cold-start
    // ingest of old mail has a recent `ingestedAt`, so that column alone is not the mail time. The
    // walk is in primary-key order, so all pages together read the Gmail rows one time.
    const page = await db()
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.source, "gmail"),
          or(
            gte(documents.authoredAt, since),
            and(isNull(documents.authoredAt), gte(documents.ingestedAt, since)),
          ),
          gt(documents.id, afterId),
        ),
      )
      .orderBy(asc(documents.id))
      .limit(PAGE_SIZE);

    const last = page.at(-1);

    if (!last) break;
    afterId = last.id;
    read += page.length;

    try {
      const mails = await triagedMails(page);
      bump("no_triage_run", page.length - mails.length);

      for (const { mail, proposal } of await proposeMailObjectLinksBatch(mails)) {
        try {
          if (proposal.status === "link") {
            bump(COMMIT ? await appendMailObjectLink(proposal.row) : "dry");
          } else {
            bump(proposal.status);
          }

          if (proposal.status !== "no_link") resolvedObjects += proposal.resolved.length;
        } catch (err) {
          bump("failed");
          console.error(`  ${mail.document.id}: ${toMessage(err)}`);
        }
      }
    } catch (err) {
      bump("failed", page.length);
      console.error(`  page after ${page[0]?.id ?? ""}: ${toMessage(err)}`);
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

/** The documents of the page with a triage verdict, each with that verdict. One read per user. */
async function triagedMails(page: readonly Document[]): Promise<MailObjectLinkInput[]> {
  const docsByUser = Map.groupBy(page, (doc) => doc.userId);
  const verdicts = new Map<string, MailObjectLinkInput["category"]>();

  for (const [userId, docs] of docsByUser) {
    const read = await readTriageVerdicts({ userId, documentIds: docs.map((doc) => doc.id) });

    for (const [id, category] of read) verdicts.set(id, category);
  }

  return page.flatMap((document) => {
    const category = verdicts.get(document.id);

    if (!category) return [];

    const sender = parseGmailDocumentMetadata(document.metadata).from ?? null;

    return [{ document, sender, category }];
  });
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

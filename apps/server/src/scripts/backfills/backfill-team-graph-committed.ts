/**
 * Build the `entities` graph from ingested Gmail `documents` (ADR-0059 P4a).
 * Headers only, no model, no network: `from`/`to`/`cc` become contacts and
 * organizations with a first significance pass. Idempotent. It writes no edge (#1108).
 *
 * Bundled for prod. Dry by default; `--commit` writes entities and scores.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-team-graph-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-team-graph-committed.js --commit
 *   # override target(s) / scan depth:
 *   TEAM_GRAPH_EMAILS="a@x.com" TEAM_GRAPH_MAX_DOCS=2000 node dist/scripts/backfills/backfill-team-graph-committed.js --commit
 */
import { gmailSenderAdapter } from "@alfred/assistant/triage";
import { backfillTeamGraph } from "@alfred/assistant/knowledge/internal";
import { warmPool } from "@alfred/db";
import { closeScriptResources } from "../script-runtime";
import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";
import { toMessage } from "@alfred/contracts";

/** Override with comma-separated `TEAM_GRAPH_EMAILS`. */
const TARGET_EMAILS = (process.env.TEAM_GRAPH_EMAILS ?? "yashgouravkar@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_DOCS = Number(process.env.TEAM_GRAPH_MAX_DOCS ?? "5000");

const COMMIT = process.argv.includes("--commit");

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const result = await backfillTeamGraph(u.userId, u.email, gmailSenderAdapter.correspondents, {
    commit: COMMIT,
    maxDocs: Number.isFinite(MAX_DOCS) ? MAX_DOCS : 5000,
  });

  // The blocked count is exact after a commit and an estimate (`~B`) on a dry run.
  const blockedLabel = result.persisted
    ? `re-kind blocked ${result.reKindBlocked}`
    : `re-kind blocked ~${result.reKindBlocked} (estimate)`;

  console.log(
    `  scanned ${result.docsScanned} docs → ${result.contacts} contacts ` +
      `(${result.nonPersonContacts} non-person, ${blockedLabel}), ${result.organizations} orgs ` +
      `(${result.persisted ? "PERSISTED" : "dry — no writes"})`,
  );
  console.log("  top contacts by significance:");

  for (const t of result.top) {
    console.log(
      `    ${t.score.toFixed(3)}  ${t.name} <${t.address}>  (in=${t.inbound} out=${t.outbound})`,
    );
  }
}

async function main() {
  await warmPool();
  console.log(
    `# Team-graph backfill — mode=${COMMIT ? "COMMIT" : "DRY"} | maxDocs=${MAX_DOCS} | targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));

  for (const email of TARGET_EMAILS) {
    if (!found.has(email)) console.log(`! no user row for ${email} — skipping`);
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

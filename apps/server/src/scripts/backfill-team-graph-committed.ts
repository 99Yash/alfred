/**
 * COMMITTED team-graph backfill (ADR-0059 P4a, one-off 2026-06-16).
 *
 * Populates the `entities` / `entity_relations` graph from already-ingested
 * Gmail `documents` for a target user — the missing passive-capture extractor
 * behind "prod `entities` = 0". Header-level only, no LLM, no network: parses
 * `from`/`to`/`cc` into person + organization entities and a first significance
 * pass. Idempotent (upsert/no-op-on-conflict/overwrite), so safe to re-run.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfill-team-graph-committed.js` — the prod image has no
 * `tsx`/loose `@alfred/*` sources.
 *
 * SAFETY: dry by default — aggregates + ranks but writes nothing. Pass
 * `--commit` to write entities/relations/scores.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfill-team-graph-committed.js
 *   # commit:
 *   node dist/scripts/backfill-team-graph-committed.js --commit
 *   # override target(s) / scan depth:
 *   TEAM_GRAPH_EMAILS="a@x.com" TEAM_GRAPH_MAX_DOCS=2000 node dist/scripts/backfill-team-graph-committed.js --commit
 */
import { backfillTeamGraph, closeConnections, closeRedis, warmPool } from "@alfred/api";
import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";
import { toMessage } from "@alfred/contracts";

/** Mailboxes to backfill. Override with `TEAM_GRAPH_EMAILS` (comma-sep). */
const TARGET_EMAILS = (process.env.TEAM_GRAPH_EMAILS ?? "yashgouravkar@gmail.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_DOCS = Number(process.env.TEAM_GRAPH_MAX_DOCS ?? "5000");
const COMMIT = process.argv.includes("--commit");

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);
  const result = await backfillTeamGraph(u.userId, u.email, {
    commit: COMMIT,
    maxDocs: Number.isFinite(MAX_DOCS) ? MAX_DOCS : 5000,
  });

  console.log(
    `  scanned ${result.docsScanned} docs → ${result.contacts} contacts, ` +
      `${result.organizations} orgs, ${result.relations} works_at edges ` +
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
    // Log only the message — a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

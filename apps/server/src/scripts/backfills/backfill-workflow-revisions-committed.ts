/**
 * COMMITTED backfill: mint revision 1 for every user-authored workflow (#555).
 *
 * Migration `0090_nappy_owl` adds `workflow_revisions` plus the two pointers
 * on `workflows`, but it cannot fill them. The content hash is SHA-256 over a
 * canonical JSON pre-image produced by `workflowRevisionContentHash`, so a SQL
 * `UPDATE` would either omit the hash or invent one that no later `revise` call
 * could reproduce. This script mints the row through the same function the
 * service uses, which is what makes "an edit that changes nothing appends no
 * revision" true for a pre-existing workflow on its very first edit.
 *
 * Per user-authored row with `current_revision_id IS NULL`:
 *
 *   1. Read the definition off the row's denormalized columns.
 *   2. Mint revision 1 with that definition and its content hash.
 *   3. Point `current_revision_id` at it, and `published_revision_id` too when
 *      the row is `active` — an active row IS running that definition, so
 *      pinning it is the truthful record. A draft/paused/archived row publishes
 *      nothing, so its published pointer stays null and an edit keeps
 *      refreshing the denormalized copy exactly as it does today.
 *
 * `allowed_tools` and `required_capabilities` stay empty. This script does not
 * guess an execution envelope for a workflow nobody reviewed; `#557`'s
 * capability resolver fills them on the next real edit.
 *
 * Built-ins are skipped by definition — their source of truth is a TS module
 * and both pointers stay null. A row with a null or empty `brief` is skipped
 * and reported: a revision with no brief has nothing to run, so inventing one
 * would be worse than leaving the row un-migrated.
 *
 * Bundled by tsdown (`noExternal: @alfred/*`) so it runs on prod with plain
 * `node dist/scripts/backfills/backfill-workflow-revisions-committed.js`.
 *
 * SAFETY: dry by default — prints what it WOULD write. `--commit` applies and
 * REQUIRES `--emails=...` so a prod shell typo cannot mutate the default
 * account. Idempotent: a row that already has a revision is never matched.
 *
 *   # preview (writes nothing):
 *   node dist/scripts/backfills/backfill-workflow-revisions-committed.js
 *   # commit:
 *   node dist/scripts/backfills/backfill-workflow-revisions-committed.js --emails=yashgouravkar@gmail.com --commit
 */
import { workflowRevisionContentHash } from "@alfred/assistant/automation";
import { warmPool } from "@alfred/db";
import { toMessage, workflowRevisionDefinitionSchema } from "@alfred/contracts";
import { db } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import { user as userTable, workflowRevisions, workflows } from "@alfred/db/schemas";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { closeScriptResources } from "../script-runtime";

const COMMIT = process.argv.includes("--commit");

function parseTargetEmails(): string[] {
  const flag = process.argv.find((arg) => arg.startsWith("--emails="));
  if (COMMIT && !flag) {
    throw new Error("--emails=a@x.com must be set explicitly when using --commit");
  }
  const raw = flag ? flag.slice("--emails=".length) : "yashgouravkar@gmail.com";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const TARGET_EMAILS = parseTargetEmails();

async function processUser(u: { userId: string; email: string }): Promise<void> {
  console.log(`\n=== ${u.email} (user=${u.userId}) ===`);

  const rows = await db()
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.userId, u.userId),
        eq(workflows.isBuiltin, false),
        isNull(workflows.currentRevisionId),
      ),
    );

  if (rows.length === 0) {
    console.log("  nothing to migrate — every user-authored row already has a revision");
    return;
  }

  let minted = 0;
  const skipped: Array<{ slug: string; reason: string }> = [];

  for (const row of rows) {
    // The row's own columns are the definition. Parsing (rather than trusting)
    // is what catches the null brief and any trigger written before the current
    // schema; an unparseable row is reported, never guessed at.
    const parsed = workflowRevisionDefinitionSchema.safeParse({
      name: row.name,
      description: row.description,
      brief: row.brief,
      trigger: row.trigger,
      allowedIntegrations: row.allowedIntegrations,
      allowedTools: [],
      requiredCapabilities: [],
    });
    if (!parsed.success) {
      const reason = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      skipped.push({ slug: row.slug, reason });
      continue;
    }

    const definition = parsed.data;
    const contentHash = workflowRevisionContentHash(definition);
    const publishes = row.status === "active";
    console.log(
      `  ${row.slug} [${row.status}] → v1 ${contentHash.slice(0, 19)}…` +
        `${publishes ? " (published)" : ""}`,
    );
    if (!COMMIT) continue;

    const revisionId = createId("wfr");
    await db().transaction(async (tx) => {
      await tx.insert(workflowRevisions).values({
        id: revisionId,
        workflowId: row.id,
        userId: u.userId,
        revisionNumber: 1,
        contentHash,
        name: definition.name,
        description: definition.description,
        brief: definition.brief,
        trigger: definition.trigger,
        allowedIntegrations: definition.allowedIntegrations,
        allowedTools: definition.allowedTools,
        requiredCapabilities: definition.requiredCapabilities,
        // An active row was approved at some point; the row's own creation is
        // the closest instant on record. A non-published revision is unapproved.
        approvedAt: publishes ? (row.createdAt ?? new Date()) : null,
      });
      await tx
        .update(workflows)
        .set({
          currentRevisionId: revisionId,
          ...(publishes ? { publishedRevisionId: revisionId } : {}),
          rowVersion: sql`${workflows.rowVersion} + 1`,
        })
        .where(and(eq(workflows.id, row.id), isNull(workflows.currentRevisionId)));
    });
    minted++;
  }

  if (skipped.length > 0) {
    console.log(`\n  SKIPPED (${skipped.length}) — no revision can be minted:`);
    for (const s of skipped) console.log(`    ${s.slug}: ${s.reason}`);
  }

  console.log(
    COMMIT
      ? `\n  COMMITTED — minted ${minted}/${rows.length - skipped.length} revisions.`
      : `\n  DRY — nothing written. Re-run with --commit to apply.`,
  );
}

async function main() {
  await warmPool();
  console.log(
    `# Mint workflow revision 1 (#555) — mode=${COMMIT ? "COMMIT" : "DRY"} | ` +
      `targets=${TARGET_EMAILS.join(", ")}`,
  );

  const users = await db()
    .select({ userId: userTable.id, email: userTable.email })
    .from(userTable)
    .where(inArray(userTable.email, TARGET_EMAILS));

  const found = new Set(users.map((u) => u.email));
  const missing = TARGET_EMAILS.filter((e) => !found.has(e));
  if (missing.length > 0) {
    const message = `no user row for target email(s): ${missing.join(", ")}`;
    if (COMMIT) throw new Error(message);
    console.log(`! ${message} — skipping`);
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
    await closeScriptResources();
  });

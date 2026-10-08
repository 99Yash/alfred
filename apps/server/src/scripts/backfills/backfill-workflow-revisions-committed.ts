/**
 * Mint revision 1 for every user-authored workflow (#555). SQL cannot do this:
 * the content hash comes from `workflowRevisionContentHash`, and a later no-op
 * edit must reproduce it.
 *
 * Per row with `current_revision_id IS NULL`: mint revision 1 from the row's
 * columns, point `current_revision_id` at it, and also `published_revision_id`
 * when the row is `active`. `allowed_tools` and `required_capabilities` stay empty.
 * Built-ins are skipped. A row with no `brief` is skipped and reported.
 *
 * Bundled for prod. Dry by default. `--commit` requires `--emails=...`. Idempotent.
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
    // Parse, so a null brief or an old trigger shape is reported, not guessed.
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
        // The row's creation time is the closest approval time on record.
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
    // Message only: a serialized Error can leak DATABASE_URL.
    console.error(toMessage(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });

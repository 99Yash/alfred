import { db } from "@alfred/db";
import { user as userTable, workflows } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { listPublicWorkflows } from "../agent/registry";

/**
 * Seed one `workflows` row per registered builtin for a given user.
 *
 * Idempotent (`ON CONFLICT (user_id, slug) DO UPDATE`) so a re-run on an
 * existing user refreshes mutable display fields (`name`, `description`,
 * `trigger`) without trampling user-controlled fields like `status`. A
 * builtin can never lose a paused state because a backfill ran — that's
 * the user's call, owned by the settings-page toggle.
 *
 * `next_run_at` is deliberately left untouched in the upsert. m12 keeps
 * per-feature ticks (briefing.tick, memory.extract.daily) authoritative
 * for the cron builtins by leaving their `next_run_at` null, so the
 * generic `workflows.tick` partial index skips them. User-authored cron
 * workflows compute `next_run_at` at write time via the CRUD path.
 *
 * Returns the count of rows touched (insert + update).
 */
export async function seedBuiltinWorkflowsForUser(userId: string): Promise<{
  seeded: number;
  slugs: string[];
}> {
  const builtins = listPublicWorkflows();
  if (builtins.length === 0) return { seeded: 0, slugs: [] };

  const rows = builtins.map((wf) => ({
    userId,
    slug: wf.slug,
    name: wf.name,
    description: wf.description ?? null,
    trigger: wf.trigger,
    brief: null,
    steps: null,
    allowedIntegrations: wf.allowedIntegrations ?? [],
    status: "active" as const,
    isBuiltin: true,
  }));

  await db()
    .insert(workflows)
    .values(rows)
    .onConflictDoUpdate({
      target: [workflows.userId, workflows.slug],
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        trigger: sql`excluded.trigger`,
        allowedIntegrations: sql`excluded.allowed_integrations`,
        // Built-ins sync via Replicache too, so the CVR needs `row_version`
        // to move when a definition-derived field actually changes —
        // otherwise a re-seeded trigger/name never reaches connected
        // clients. Guard with IS DISTINCT FROM so an unchanged re-seed
        // (every boot) doesn't churn the version or force redundant pulls.
        rowVersion: sql`CASE WHEN (${workflows.name}, ${workflows.description}, ${workflows.trigger}, ${workflows.allowedIntegrations})
          IS DISTINCT FROM (excluded.name, excluded.description, excluded.trigger, excluded.allowed_integrations)
          THEN ${workflows.rowVersion} + 1 ELSE ${workflows.rowVersion} END`,
        // Crucially: `status` and `next_run_at` are NOT in the SET
        // list. A user-paused builtin stays paused across deploys; a
        // cron schedule update doesn't re-arm a builtin behind the
        // user's back.
        updatedAt: sql`now()`,
      },
    });

  return { seeded: rows.length, slugs: rows.map((r) => r.slug) };
}

/**
 * Re-seed builtin `workflows` rows for EVERY existing user.
 *
 * The per-user seeder runs only in the on-user-created hook, so a builtin's
 * mutable fields (`trigger`, `name`, `description`, `allowed_integrations`)
 * never reach pre-existing users on deploy. That gap silently broke email
 * triage in production: the trigger shape changed in code
 * (`gmail.poll_history` → `gmail.ingest` → `gmail`/`message_received`) but the
 * existing user's row stayed frozen at the original value, so `emitEvent`
 * matched zero workflows and no triage runs were created.
 *
 * Calling this at boot closes that drift class: the `ON CONFLICT DO UPDATE`
 * still leaves user-owned fields (`status`, `next_run_at`) untouched, so a
 * paused builtin stays paused — we only resync the definition-derived fields.
 * Idempotent and cheap (single-user scale); safe to run on every boot.
 */
export async function seedBuiltinWorkflowsForAllUsers(): Promise<{
  users: number;
  rowsTouched: number;
}> {
  const users = await db().select({ id: userTable.id }).from(userTable);
  let rowsTouched = 0;
  for (const u of users) {
    const result = await seedBuiltinWorkflowsForUser(u.id);
    rowsTouched += result.seeded;
  }
  return { users: users.length, rowsTouched };
}

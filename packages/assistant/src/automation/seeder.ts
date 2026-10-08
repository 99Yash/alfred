import { db } from "@alfred/db";
import { user as userTable, workflows } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { listPublicWorkflows, listResumeOnlyWorkflows } from "@alfred/assistant/execution";

export interface BuiltinWorkflowSeedPlan {
  seed: ReturnType<typeof listPublicWorkflows>;
  retireSlugs: string[];
}

export function getBuiltinWorkflowSeedPlan(): BuiltinWorkflowSeedPlan {
  return {
    seed: listPublicWorkflows(),
    retireSlugs: listResumeOnlyWorkflows().map((workflow) => workflow.slug),
  };
}

/**
 * Upsert one `workflows` row per builtin for a user. Refreshes the definition fields and
 * never touches `status` or `next_run_at`, so a paused builtin stays paused.
 * Cron builtins keep `next_run_at` null: their own ticks (`briefing.tick`,
 * `memory.extract.daily`) run them, and `workflows.tick` skips them.
 * Resume-only definitions are deleted, but only when the row is a builtin.
 */
export async function seedBuiltinWorkflowsForUser(userId: string): Promise<{
  seeded: number;
  retired: number;
  slugs: string[];
}> {
  const { seed: builtins, retireSlugs } = getBuiltinWorkflowSeedPlan();

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

  const retired = await db().transaction(async (tx) => {
    const retiredRows =
      retireSlugs.length === 0
        ? []
        : await tx
            .delete(workflows)
            .where(
              and(
                eq(workflows.userId, userId),
                eq(workflows.isBuiltin, true),
                inArray(workflows.slug, retireSlugs),
              ),
            )
            .returning({ id: workflows.id });

    if (rows.length > 0) {
      await tx
        .insert(workflows)
        .values(rows)
        .onConflictDoUpdate({
          target: [workflows.userId, workflows.slug],
          set: {
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            trigger: sql`excluded.trigger`,
            allowedIntegrations: sql`excluded.allowed_integrations`,
            // Bump `row_version` only on a real change, so Replicache gets it and a
            // no-op re-seed at every boot does not churn.
            rowVersion: sql`CASE WHEN (${workflows.name}, ${workflows.description}, ${workflows.trigger}, ${workflows.allowedIntegrations})
              IS DISTINCT FROM (excluded.name, excluded.description, excluded.trigger, excluded.allowed_integrations)
              THEN ${workflows.rowVersion} + 1 ELSE ${workflows.rowVersion} END`,
            // `status` and `next_run_at` are left out on purpose.
            updatedAt: sql`now()`,
          },
        });
    }

    return retiredRows.length;
  });

  return { seeded: rows.length, retired, slugs: rows.map((r) => r.slug) };
}

/**
 * Re-seed builtins for every user. Run at boot: otherwise a changed builtin trigger
 * never reaches existing users. That once stopped email triage in production.
 * Idempotent and cheap.
 */
export async function seedBuiltinWorkflowsForAllUsers(): Promise<{
  users: number;
  rowsTouched: number;
  rowsRetired: number;
}> {
  const users = await db().select({ id: userTable.id }).from(userTable);
  let rowsTouched = 0;
  let rowsRetired = 0;

  for (const u of users) {
    const result = await seedBuiltinWorkflowsForUser(u.id);
    rowsTouched += result.seeded;
    rowsRetired += result.retired;
  }

  return { users: users.length, rowsTouched, rowsRetired };
}

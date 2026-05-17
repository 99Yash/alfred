import { db } from "@alfred/db";
import { workflows } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { listWorkflows } from "../agent/registry";

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
  const builtins = listWorkflows();
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
        // Crucially: `status` and `next_run_at` are NOT in the SET
        // list. A user-paused builtin stays paused across deploys; a
        // cron schedule update doesn't re-arm a builtin behind the
        // user's back.
        updatedAt: sql`now()`,
      },
    });

  return { seeded: rows.length, slugs: rows.map((r) => r.slug) };
}

/**
 * Backfill builtin `workflows` rows for every existing user.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/seed-builtin-workflows.ts
 *
 * `seedBuiltinWorkflowsForUser` is idempotent (ON CONFLICT DO UPDATE
 * leaves status/next_run_at alone), so this is safe to re-run. It also
 * picks up any new builtins added since the last invocation — handy
 * when shipping a new builtin (e.g. a new boss-agent workflow in m13)
 * without forcing a re-signup.
 */
import {
  closeConnections,
  seedBuiltinWorkflowsForUser,
  warmPool,
} from "@alfred/api";
import { db } from "@alfred/db";
import { user as userTable } from "@alfred/db/schemas";
import { registerBuiltinWorkflows } from "../builtins";

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const users = await db().select({ id: userTable.id, email: userTable.email }).from(userTable);
  if (users.length === 0) {
    console.log("[seed-builtin-workflows] no users; nothing to seed.");
    return;
  }

  let totalRows = 0;
  for (const u of users) {
    const result = await seedBuiltinWorkflowsForUser(u.id);
    totalRows += result.seeded;
    console.log(
      `[seed-builtin-workflows] user=${u.email} (${u.id}) seeded=${result.seeded} slugs=${result.slugs.join(",")}`,
    );
  }

  console.log(
    `[seed-builtin-workflows] done: users=${users.length} totalRowsTouched=${totalRows}`,
  );
}

main()
  .catch((err) => {
    console.error("[seed-builtin-workflows] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections();
  });

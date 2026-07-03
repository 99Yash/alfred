/**
 * Backfill builtin `workflows` rows for every existing user.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/ops/seed-builtin-workflows.ts
 *
 * `seedBuiltinWorkflowsForUser` is idempotent (ON CONFLICT DO UPDATE
 * leaves status/next_run_at alone), so this is safe to re-run. It also
 * picks up any new builtins added since the last invocation — handy
 * when shipping a new builtin (e.g. a new boss-agent workflow in m13)
 * without forcing a re-signup.
 */
import { closeConnections, seedBuiltinWorkflowsForAllUsers, warmPool } from "@alfred/api";
import { registerBuiltinWorkflows } from "../../builtins";

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const { users, rowsTouched } = await seedBuiltinWorkflowsForAllUsers();
  if (users === 0) {
    console.log("[seed-builtin-workflows] no users; nothing to seed.");
    return;
  }

  console.log(`[seed-builtin-workflows] done: users=${users} totalRowsTouched=${rowsTouched}`);
}

main()
  .catch((err) => {
    console.error("[seed-builtin-workflows] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections();
  });

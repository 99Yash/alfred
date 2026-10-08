/**
 * Seed builtin `workflows` rows for every existing user, including newly shipped
 * builtins. Idempotent: the upsert leaves status and next_run_at alone.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/ops/seed-builtin-workflows.ts
 */
import { closeConnections, warmPool } from "@alfred/db";
import { seedBuiltinWorkflowsForAllUsers } from "@alfred/assistant/automation";
import { registerBuiltinWorkflows } from "~/builtins";

async function main() {
  await warmPool();
  registerBuiltinWorkflows();

  const { users, rowsTouched, rowsRetired } = await seedBuiltinWorkflowsForAllUsers();

  if (users === 0) {
    console.log("[seed-builtin-workflows] no users; nothing to seed.");

    return;
  }

  console.log(
    `[seed-builtin-workflows] done: users=${users} totalRowsTouched=${rowsTouched} retired=${rowsRetired}`,
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

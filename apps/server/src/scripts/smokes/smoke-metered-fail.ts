/**
 * Verifies the failure path of `metered()`: an SDK error must land an
 * api_call_log row (cost_usd=0, error column populated) and rethrow.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smokes/smoke-metered-fail.ts
 */
import { metered } from "@alfred/ai";
import { closeConnections, warmPool } from "@alfred/api/runtime";
import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { desc, eq } from "drizzle-orm";

async function main() {
  await warmPool();

  let threw = false;
  try {
    await metered(
      {
        kind: "llm",
        provider: "synthetic",
        model: "fail-on-purpose",
        idempotencyKey: `fail-${Date.now()}`,
      },
      async () => {
        throw new Error("synthetic failure for smoke test");
      },
    );
  } catch (err) {
    threw = true;
    if (!(err instanceof Error) || err.message !== "synthetic failure for smoke test") {
      throw new Error(`unexpected rethrow shape: ${String(err)}`);
    }
  }
  if (!threw) throw new Error("metered() swallowed the inner throw");

  await new Promise((r) => setTimeout(r, 500));

  const rows = await db()
    .select()
    .from(apiCallLog)
    .where(eq(apiCallLog.provider, "synthetic"))
    .orderBy(desc(apiCallLog.id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("no failure row in api_call_log");

  console.log(`[fail-smoke] failure row: cost=${row.costUsd} error=${JSON.stringify(row.error)}`);
  if (Number(row.costUsd) !== 0)
    throw new Error(`expected cost_usd=0 on failure, got ${row.costUsd}`);
  const err = row.error as { message?: string } | null;
  if (err?.message !== "synthetic failure for smoke test") {
    throw new Error(`error column not populated correctly: ${JSON.stringify(row.error)}`);
  }

  console.log("\n[fail-smoke] PASS");
}

main()
  .catch((err) => {
    console.error("[fail-smoke] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeConnections().catch(() => {});
  });

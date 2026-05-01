/**
 * Smoke test for m6 cost metering.
 *
 *   $ pnpm tsx --env-file=.env src/scripts/smoke-metered.ts
 *
 * Makes one cheap real LLM call through `meteredGenerateText`,
 * verifies an `api_call_log` row landed with non-zero usage and
 * computed cost, and (when LANGFUSE_* keys are present) flushes the
 * span so it shows up in the Langfuse dashboard.
 */
import { flushLangfuse, getCheapModel, meteredGenerateText } from "@alfred/ai";
import { closeConnections, warmPool } from "@alfred/api";
import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { desc } from "drizzle-orm";

async function main() {
  await warmPool();

  const before = (await db().select().from(apiCallLog)).length;
  console.log(`[smoke-metered] starting log row count: ${before}`);

  const idempotencyKey = `smoke-${Date.now()}`;
  console.log(`[smoke-metered] calling Gemini Flash (idempotency=${idempotencyKey})…`);

  const result = await meteredGenerateText(
    {
      model: getCheapModel(),
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 5,
    },
    {
      idempotencyKey,
      requestMeta: { purpose: "m6-smoke" },
    },
  );
  console.log(`[smoke-metered] response: ${JSON.stringify(result.text)}`);

  // Wait briefly for the fire-and-forget DB write.
  await new Promise((r) => setTimeout(r, 500));

  const after = await db()
    .select()
    .from(apiCallLog)
    .orderBy(desc(apiCallLog.id))
    .limit(1);
  const row = after[0];
  if (!row) throw new Error("no api_call_log row appeared after metered call");

  console.log(`[smoke-metered] log row:`);
  console.log(`   provider=${row.provider} model=${row.model}`);
  console.log(
    `   input=${row.inputTokens} output=${row.outputTokens} cached=${row.cachedInputTokens}`,
  );
  console.log(`   cost_usd=${row.costUsd} latency_ms=${row.latencyMs}`);
  console.log(`   request_meta=${JSON.stringify(row.requestMeta)}`);
  console.log(`   response_meta=${JSON.stringify(row.responseMeta)}`);

  if ((row.inputTokens ?? 0) <= 0 && (row.outputTokens ?? 0) <= 0) {
    throw new Error("usage extraction failed — both input and output tokens are 0");
  }
  if (Number(row.costUsd) <= 0) {
    throw new Error(
      `cost computation failed — got ${row.costUsd} (expected > 0). Check that ${row.provider}/${row.model} is in model_prices.`,
    );
  }
  const meta = row.requestMeta as { idempotencyKey?: string } | null;
  if (meta?.idempotencyKey !== idempotencyKey) {
    throw new Error(`idempotency key not persisted: got ${meta?.idempotencyKey}`);
  }

  console.log("\n[smoke-metered] PASS");
}

main()
  .catch((err) => {
    console.error("[smoke-metered] FAIL", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await flushLangfuse().catch(() => {});
    await closeConnections().catch(() => {});
  });

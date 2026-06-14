/**
 * Smoke test for `withFallback` (ai-retry cascade) + served-model metering.
 *
 *   $ pnpm --filter server tsx --env-file=.env src/scripts/smoke-fallback.ts
 *
 * Three checks:
 *   1. Normal path — a `withFallback`-wrapped healthy primary serves from
 *      Anthropic and `api_call_log` attributes anthropic/claude-sonnet-4-6.
 *   2. Fallback path — a primary bound to a nonexistent Anthropic model id
 *      hard-errors, the cascade switches to Gemini, the call still succeeds,
 *      and the log row re-attributes to the served Google model.
 *   3. The dispatchers (`getBossModel`/`getChatModel`) return retryable
 *      models that proxy provider/modelId to the primary.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { getBossModel, getChatModel, meteredGenerateText, withFallback } from "@alfred/ai";
import { toRecord } from "@alfred/contracts";
import { db, closeConnections } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { desc, eq } from "drizzle-orm";

async function lastLogRow(idempotencyKey: string) {
  // requestMeta.idempotencyKey is inside jsonb; cheap approach: latest llm rows
  const rows = await db()
    .select()
    .from(apiCallLog)
    .where(eq(apiCallLog.kind, "llm"))
    .orderBy(desc(apiCallLog.createdAt))
    .limit(5);
  return rows.find(
    (r) => toRecord(r.requestMeta).idempotencyKey === idempotencyKey,
  );
}

async function main() {
  let failures = 0;

  // --- 3. dispatcher identity proxying -------------------------------------
  const boss = getBossModel() as { provider?: string; modelId?: string };
  const chatDeep = getChatModel("deep") as { provider?: string; modelId?: string };
  console.log(`boss model       → ${boss.provider}/${boss.modelId}`);
  console.log(`chat deep model  → ${chatDeep.provider}/${chatDeep.modelId}`);
  if (boss.modelId !== "claude-sonnet-4-6" || chatDeep.modelId !== "claude-opus-4-8") {
    console.error("FAIL: dispatcher modelId proxy mismatch");
    failures++;
  }

  // --- 1. normal path -------------------------------------------------------
  const okKey = `smoke-fallback-ok-${process.pid}`;
  const okModel = withFallback(anthropic("claude-sonnet-4-6"), google("gemini-2.5-flash-lite"));
  const ok = await meteredGenerateText(
    { model: okModel, prompt: "Reply with exactly: ok", maxOutputTokens: 8 },
    { idempotencyKey: okKey, requestMeta: { smoke: "fallback-normal" } },
  );
  console.log(`normal path      → text=${JSON.stringify(ok.text.trim())}`);

  // --- 2. fallback path -----------------------------------------------------
  const fbKey = `smoke-fallback-switch-${process.pid}`;
  const fbModel = withFallback(
    anthropic("claude-nonexistent-smoke-model"),
    google("gemini-2.5-flash-lite"),
  );
  const fb = await meteredGenerateText(
    { model: fbModel, prompt: "Reply with exactly: ok", maxOutputTokens: 8 },
    { idempotencyKey: fbKey, requestMeta: { smoke: "fallback-switch" } },
  );
  console.log(`fallback path    → text=${JSON.stringify(fb.text.trim())}`);
  console.log(`fallback served  → response.modelId=${fb.response?.modelId}`);

  // give the fire-and-forget log writes a beat to land
  await new Promise((r) => setTimeout(r, 1_500));

  const okRow = await lastLogRow(okKey);
  const fbRow = await lastLogRow(fbKey);
  console.log(
    `log normal       → provider=${okRow?.provider} model=${okRow?.model} cost=${okRow?.costUsd}`,
  );
  console.log(
    `log fallback     → provider=${fbRow?.provider} model=${fbRow?.model} cost=${fbRow?.costUsd} responseMeta=${JSON.stringify(fbRow?.responseMeta)}`,
  );

  if (okRow?.provider !== "anthropic" || okRow?.model !== "claude-sonnet-4-6") {
    console.error("FAIL: normal-path attribution should be anthropic/claude-sonnet-4-6");
    failures++;
  }
  if (fbRow?.provider !== "google") {
    console.error("FAIL: fallback-path attribution should re-resolve to google");
    failures++;
  }

  console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures})`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("smoke-fallback crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => void closeConnections());

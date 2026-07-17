/**
 * One-off backfill for the dev usage readout (models + tokens + cost) on chat
 * turns that finished BEFORE the `chat_messages.usage` column existed
 * (introduced today in e239c705 / migration 0084).
 *
 * The live path (`aggregateRunUsage` in workflows/chat-turn.ts) rolls the
 * numbers up from the turn's `api_call_log` rows at finalize, keyed on the boss
 * `runId`. Those metering rows are the ADR-0015 source of truth and are NOT
 * pruned, so every older assistant message is still backfillable from our own
 * DB — no Langfuse round-trip needed (Langfuse only mirrors `api_call_log.model`
 * and has retention limits the DB doesn't). This script reruns that exact
 * aggregation for messages whose `usage` is still null.
 *
 * Dry-run by default (reports what it WOULD write); pass --commit to persist.
 *
 *   $ pnpm --filter @alfred/api exec tsx src/scripts/backfill-chat-usage.ts
 *   $ pnpm --filter @alfred/api exec tsx src/scripts/backfill-chat-usage.ts --commit
 *
 * Scope (identical to the live feature):
 *   - role='assistant' rows with a non-null run_id whose usage rollup is
 *     incomplete: either usage is null (finalized before the column existed) OR
 *     usage was written by an early build that omitted the `models` array (the
 *     model chips render off `usage.models`, so those turns show the token/cost
 *     line but no model — the whole point of the readout);
 *   - sub-agent child runs are excluded (billed under their own run ids);
 *   - a turn whose api_call_log rows are gone (INNER JOIN misses) stays as-is —
 *     the UI already renders a missing/empty rollup gracefully.
 */

import { db, closeConnections } from "@alfred/db";
import { apiCallLog, chatMessages } from "@alfred/db/schemas";
import { chatMessageUsageSchema, type ChatMessageUsage } from "@alfred/contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { foldModelUsage } from "../modules/agent/usage-fold";

const COMMIT = process.argv.includes("--commit");

/**
 * One `api_call_log` group per (message, model), summed across the message's
 * run — the same GROUP BY `aggregateRunUsage` runs, widened to carry the owning
 * message id so we can fold every candidate in a single scan (no N+1).
 */
async function loadGroups(): Promise<
  Array<{
    messageId: string;
    model: string;
    inputTokens: string;
    outputTokens: string;
    cachedInputTokens: string;
    costUsd: string;
    calls: string;
  }>
> {
  return db()
    .select({
      messageId: chatMessages.id,
      model: sql<string>`coalesce(${apiCallLog.model}, 'unknown')`,
      inputTokens: sql<string>`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(chatMessages)
    .innerJoin(apiCallLog, eq(apiCallLog.runId, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.runId),
        // null usage OR usage present but with an empty/absent `models` array.
        sql`(${chatMessages.usage} is null or coalesce(jsonb_array_length(${chatMessages.usage} -> 'models'), 0) = 0)`,
      ),
    )
    .groupBy(chatMessages.id, sql`coalesce(${apiCallLog.model}, 'unknown')`);
}

/**
 * Bucket the per-(message, model) groups by message, then fold each bucket into
 * one validated ChatMessageUsage via the shared {@link foldModelUsage} — the
 * same rollup the live `aggregateRunUsage` runs, so the backfill can't drift
 * from the finalize path.
 */
function foldUsage(groups: Awaited<ReturnType<typeof loadGroups>>): Map<string, ChatMessageUsage> {
  const rowsByMessage = new Map<string, Awaited<ReturnType<typeof loadGroups>>>();
  for (const row of groups) {
    const rows = rowsByMessage.get(row.messageId) ?? [];
    rows.push(row);
    rowsByMessage.set(row.messageId, rows);
  }
  const byMessage = new Map<string, ChatMessageUsage>();
  for (const [messageId, rows] of rowsByMessage) {
    byMessage.set(messageId, foldModelUsage(rows));
  }
  return byMessage;
}

async function main(): Promise<void> {
  const groups = await loadGroups();
  const byMessage = foldUsage(groups);

  let written = 0;
  let skipped = 0;
  for (const [messageId, raw] of byMessage) {
    // Validate the fold against the wire schema before it becomes a durable row.
    const parsed = chatMessageUsageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.calls === 0) {
      skipped++;
      continue;
    }
    const usage = parsed.data;
    const models = usage.models.map((m) => `${m.model}×${m.calls}`).join(", ");
    console.log(
      `${COMMIT ? "write" : "would write"} ${messageId} — ${usage.calls} calls, ` +
        `$${usage.costUsd.toFixed(4)}, in=${usage.inputTokens} out=${usage.outputTokens} — [${models}]`,
    );
    if (COMMIT) {
      // Bump rowVersion + updatedAt so the change is delivered on the next
      // Replicache pull (the synced read model carries `usage`).
      await db()
        .update(chatMessages)
        .set({
          usage,
          rowVersion: sql`${chatMessages.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(chatMessages.id, messageId));
    }
    written++;
  }

  console.log(
    `\n${COMMIT ? "backfilled" : "dry-run"}: ${written} message(s) ${COMMIT ? "updated" : "to update"}` +
      `${skipped > 0 ? `, ${skipped} skipped (no billable calls)` : ""}.` +
      (COMMIT ? "" : "\nRe-run with --commit to persist."),
  );
  await closeConnections();
}

void main();

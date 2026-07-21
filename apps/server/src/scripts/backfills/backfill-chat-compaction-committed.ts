/**
 * One-time existing-thread scan for chat compaction (#370).
 *
 * New successful turns maintain replay estimates and enqueue compaction in the
 * live workflow. Threads that predate that wiring need one bounded scan or they
 * remain unprotected until the user talks in them again.
 *
 * SAFETY: dry by default. `--commit` requires an explicit `--user-id=...` and
 * invokes the production scheduler, which writes the replay estimate and only
 * enqueues threads above its canonical threshold. Work is rate-limited with
 * `--delay-ms` (default 250) and bounded with `--limit` (default 250).
 *
 *   node dist/scripts/backfills/backfill-chat-compaction-committed.js --user-id=user_123
 *   node dist/scripts/backfills/backfill-chat-compaction-committed.js --user-id=user_123 --commit
 */
import {
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  scheduleConversationCompactionIfNeeded,
} from "@alfred/api/backend";
import { COMPACTOR_MODEL, getChatModel, resolveEffectiveInputWindowTokens } from "@alfred/ai";
import { warmPool } from "@alfred/api/runtime";
import { closeScriptResources } from "../script-runtime";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages, chatThreads } from "@alfred/db/schemas";
import { and, asc, desc, eq } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");
const USER_ID = stringFlag("user-id");
const LIMIT = integerFlag("limit", 250, 1, 10_000);
const DELAY_MS = integerFlag("delay-ms", 250, 0, 10_000);

if (COMMIT && !USER_ID) {
  throw new Error("--user-id=... is required with --commit");
}

async function main(): Promise<void> {
  await warmPool();
  const effectiveWindow = await resolveEffectiveInputWindowTokens({
    models: [getChatModel("standard"), COMPACTOR_MODEL],
    outputReserveTokens: CHAT_MAX_OUTPUT_TOKENS,
  });
  const threshold = backgroundCompactionThresholdTokens(effectiveWindow);
  console.log(
    `# Chat-compaction backfill — mode=${COMMIT ? "COMMIT" : "DRY"} ` +
      `limit=${LIMIT} delayMs=${DELAY_MS} threshold=${threshold}`,
  );

  const threads = await db()
    .select({ id: chatThreads.id, userId: chatThreads.userId })
    .from(chatThreads)
    .where(USER_ID ? eq(chatThreads.userId, USER_ID) : undefined)
    .orderBy(asc(chatThreads.lastMessageAt), asc(chatThreads.id))
    .limit(LIMIT);

  let scheduled = 0;
  let deduplicated = 0;
  let belowThreshold = 0;
  let noBoundary = 0;
  let disabled = 0;
  for (const [index, thread] of threads.entries()) {
    const [latestUser] = await db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, thread.userId),
          eq(chatMessages.threadId, thread.id),
          eq(chatMessages.role, "user"),
        ),
      )
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(1);
    if (!latestUser) {
      noBoundary += 1;
      continue;
    }
    if (!COMMIT) {
      console.log(`  DRY thread=${thread.id} latestUser=${latestUser.id}`);
      continue;
    }

    const outcome = await scheduleConversationCompactionIfNeeded({
      userId: thread.userId,
      threadId: thread.id,
      latestUserMessageId: latestUser.id,
      tier: "standard",
    });
    if (outcome === "scheduled") scheduled += 1;
    else if (outcome === "deduplicated") deduplicated += 1;
    else if (outcome === "below_threshold") belowThreshold += 1;
    else if (outcome === "disabled") disabled += 1;
    else noBoundary += 1;

    if (DELAY_MS > 0 && index < threads.length - 1) await sleep(DELAY_MS);
  }

  console.log(
    COMMIT
      ? `# scanned=${threads.length} scheduled=${scheduled} deduplicated=${deduplicated} ` +
          `belowThreshold=${belowThreshold} noBoundary=${noBoundary} disabled=${disabled}`
      : `# scanned=${threads.length}; pass --commit with --user-id to persist estimates and enqueue only over-threshold threads`,
  );
}

function stringFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  return value || undefined;
}

function integerFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = stringFlag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(toMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeScriptResources();
  });

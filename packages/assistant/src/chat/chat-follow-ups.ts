import { route, meteredGenerateObject } from "@alfred/ai";
import { sanitizeVoice } from "@alfred/ai/voice";
import { CHAT_FOLLOW_UP_LIMIT, chatFollowUpsSchema, collapseWhitespace } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { logger } from "@alfred/logging";

const FOLLOW_UPS_TIMEOUT_MS = 10_000;

const FOLLOW_UPS_SYSTEM_PROMPT = [
  "You suggest what the user might ask Alfred next, after one chat exchange.",
  `Write 0 to ${CHAT_FOLLOW_UP_LIMIT} short prompts in the user's own voice that continue this exchange.`,
  "Each is under 12 words: an imperative or a question the user would type.",
  "Each must be a different next step. Do not repeat or rephrase the user's last message.",
  "No numbering, no quotes, no emoji, no dashes.",
  "Return an empty list when the reply closes the topic or needs no next step.",
].join("\n");

// Loose on purpose: the caps are applied after cleaning, so one bad entry drops alone.
const followUpsOutputSchema = z.object({
  followUps: z.array(z.string()).max(CHAT_FOLLOW_UP_LIMIT * 2),
});

/** Write up to 3 next-prompt suggestions onto a completed reply (ADR-0112). Never throws. */
export async function maybeGenerateFollowUps(args: {
  userId: string;
  runId: string;
  threadId: string;
  assistantMessageId: string;
  userMessageId: string | undefined;
  assistantText: string;
}): Promise<void> {
  const { userId, runId, threadId, assistantMessageId, userMessageId, assistantText } = args;

  if (assistantText.trim().length === 0) return;

  try {
    const userRow = userMessageId
      ? await db()
          .select({ content: chatMessages.content })
          .from(chatMessages)
          .where(and(eq(chatMessages.id, userMessageId), eq(chatMessages.userId, userId)))
          .limit(1)
      : [];

    const userText = userRow[0]?.content.trim() ?? "";

    const result = await meteredGenerateObject(
      {
        model: route("cheap").model(),
        schema: followUpsOutputSchema,
        schemaName: "chat_follow_ups",
        instructions: FOLLOW_UPS_SYSTEM_PROMPT,
        prompt: [
          userText.length > 0 ? `User: ${userText.slice(0, 2_000)}` : null,
          `Alfred: ${assistantText.slice(0, 4_000)}`,
        ]
          .filter((line): line is string => line !== null)
          .join("\n\n"),
        temperature: 0.4,
        maxOutputTokens: 200,
        timeout: FOLLOW_UPS_TIMEOUT_MS,
      },
      { kind: "llm", userId, runId, sessionId: threadId, name: "chat.follow-ups" },
    );

    const parsed = chatFollowUpsSchema.safeParse(cleanFollowUps(result.output.followUps));

    if (!parsed.success) return;

    // Only the completed reply this run wrote. A retry that replaced the row gets nothing.
    await db()
      .update(chatMessages)
      .set({ followUps: parsed.data, rowVersion: sql`${chatMessages.rowVersion} + 1` })
      .where(
        and(
          eq(chatMessages.id, assistantMessageId),
          eq(chatMessages.userId, userId),
          eq(chatMessages.runId, runId),
          eq(chatMessages.status, "complete"),
        ),
      );
    emitReplicachePokes([userId]);
  } catch (err) {
    logger.warn(
      { err, event: "chat_follow_ups_failed", threadId, runId },
      "Chat follow-up suggestions failed",
    );
  }
}

/** Clean model prompts: no dashes, no list marks or quotes, no duplicates, at most the limit. */
function cleanFollowUps(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    let s = collapseWhitespace(sanitizeVoice(entry));

    s = s.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
    s = s.replace(/^["'“”`]+|["'“”`]+$/g, "").trim();

    // `sanitizeVoice` keeps dashes inside quotes; the copy rule allows none.
    if (s.length === 0 || /[—–]/.test(s)) continue;

    const key = s.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }

  return out.slice(0, CHAT_FOLLOW_UP_LIMIT);
}

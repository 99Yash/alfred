import { getCheapModel, meteredGenerateText } from "@alfred/ai";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments, chatMessages, chatThreads } from "@alfred/db/schemas";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { emitReplicachePokes } from "../../../events/replicache-events";

const TITLE_TIMEOUT_MS = 15_000;

/**
 * Cosmetic cap on a generated thread title — matches the placeholder cap in
 * the chat turn endpoint so the sidebar row never has to ellipsize twice.
 */
const TITLE_MAX_CHARS = 60;

const TITLE_SYSTEM_PROMPT = [
  "You write very short titles for a chat conversation.",
  "Given the opening exchange, reply with a 2–6 word title naming the topic.",
  "Use Title Case. No surrounding quotes, no trailing punctuation, no emoji.",
  "Reply with the title only — nothing else.",
].join("\n");

/**
 * Derive a human title for the thread from its first exchange. Runs exactly
 * once — on the thread's first assistant reply — then leaves the title alone
 * on later turns. The turn endpoint already seeded a placeholder (the
 * truncated first message), so this is a refinement, not the only title the
 * user ever sees. Never throws into the turn: a title is cosmetic and a model
 * blip must not fail an otherwise-good reply.
 *
 * One of the three followups a healthy chat turn arms — see the
 * `arm-followups` tail in `./chat-turn-closure`.
 */
export async function maybeGenerateThreadTitle(args: {
  userId: string;
  runId: string;
  threadId: string;
  assistantMessageId: string;
  assistantText: string;
}): Promise<void> {
  const { userId, runId, threadId, assistantMessageId, assistantText } = args;
  try {
    // Only the first reply names the thread. Any earlier assistant row means
    // the title was already derived on a prior turn — leave it.
    const priorReply = await db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "assistant"),
          ne(chatMessages.id, assistantMessageId),
        ),
      )
      .limit(1);
    if (priorReply.length > 0) return;

    const firstUser = await db()
      .select({ id: chatMessages.id, content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.userId, userId),
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "user"),
        ),
      )
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      .limit(1);
    const userText = firstUser[0]?.content?.trim() ?? "";
    const firstUserId = firstUser[0]?.id;
    const attachmentNames =
      userText.length === 0 && firstUserId
        ? await db()
            .select({ name: chatAttachments.name })
            .from(chatAttachments)
            .where(
              and(eq(chatAttachments.userId, userId), eq(chatAttachments.messageId, firstUserId)),
            )
            .orderBy(
              asc(chatAttachments.position),
              asc(chatAttachments.createdAt),
              asc(chatAttachments.id),
            )
            .limit(3)
        : [];
    const userLine =
      userText.length > 0
        ? `User: ${userText.slice(0, 1_000)}`
        : attachmentNames.length > 0
          ? `User: [Attached image${attachmentNames.length === 1 ? "" : "s"}: ${attachmentNames
              .map((a) => a.name)
              .join(", ")}]`
          : null;
    const assistantLine =
      assistantText.trim().length > 0 ? `Alfred: ${assistantText.slice(0, 1_000)}` : null;
    if (!userLine && !assistantLine) return;

    const result = await meteredGenerateText(
      {
        model: getCheapModel(),
        instructions: TITLE_SYSTEM_PROMPT,
        prompt: [userLine, assistantLine, "", "Title:"]
          .filter((line): line is string => line !== null)
          .join("\n"),
        temperature: 0.3,
        maxOutputTokens: 32,
        timeout: TITLE_TIMEOUT_MS,
      },
      { kind: "llm", userId, runId, sessionId: threadId, name: "chat.thread-title" },
    );

    const title = cleanTitle(result.text);
    if (!title) return;

    await db()
      .update(chatThreads)
      .set({ title, rowVersion: sql`${chatThreads.rowVersion} + 1` })
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
    emitReplicachePokes([userId]);
  } catch (err) {
    console.warn(`[chat-turn] thread title generation failed for ${threadId}:`, toMessage(err));
  }
}

/**
 * Normalize a model-produced title: drop a leading "Title:" echo, strip
 * wrapping quotes, collapse whitespace, trim trailing punctuation, and cap
 * the length. Returns null when nothing usable remains.
 */
function cleanTitle(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;
  s = s.replace(/^title\s*[:\-—]\s*/i, "");
  s = s.replace(/^["'“”`]+|["'“”`]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.。!?]+$/, "").trim();
  if (s.length === 0) return null;
  if (s.length > TITLE_MAX_CHARS) s = `${s.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
  return s;
}

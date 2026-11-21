import type { StoredUserMessage } from "@alfred/ai";
import type { ChatMessage } from "@alfred/db/schemas";
import { z } from "zod";
import { chatTurnContextSchema, type ChatTurnContext, type IanaTimezone } from "@alfred/contracts";
import { chatTurnContexts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { buildThreadArtifactsContext } from "@alfred/assistant/artifacts";
import type { AgentDbExecutor } from "@alfred/assistant/execution";
import { settings } from "@alfred/assistant/settings";
import { formatDay, formatHourMinute, inZone } from "@alfred/assistant/time";

/**
 * The turn context (ADR-0130 decision 7, amendment (e)): the time note and the artifact context
 * of one user message. Admission saves it once, and each later turn replays the same bytes after
 * that message. Thus no part of it breaks the prompt cache. Each message carries its local send
 * time, and the full date shows only when time has passed.
 */

/**
 * A user message, or a run that continues, after this pause gets a time note. The eval of
 * ADR-0130 decision 7 sets the final value.
 */
export const TIME_NOTE_PAUSE_MS = 30 * 60_000;

/** What a parked run waited on. The time note of the resumed run names it. */
export const parkWaitSchema = z.enum(["approval", "question", "sub_agent"]);

export type ParkWait = z.infer<typeof parkWaitSchema>;

const WAIT_TEXT = {
  approval: "the user's approval",
  question: "the user's answer to a question",
  sub_agent: "a sub-agent",
} as const satisfies Record<ParkWait, string>;

/** `Saturday, 21 November 2026, 14:05 (Asia/Kolkata, UTC+05:30)`. The model does not need seconds. */
function formatLocalInstant(timezone: IanaTimezone, at: Date): string {
  const clock = inZone(timezone).clock(at);

  return `${formatDay(clock.localDate, "long")}, ${formatHourMinute(clock)} (${timezone}, UTC${clock.utcOffset})`;
}

/** `45 min`, `2 h 14 min`, or `3 days 2 h`. */
function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));

  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);

  if (hours < 48) return minutes % 60 > 0 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);

  return hours % 24 > 0 ? `${days} days ${hours % 24} h` : `${days} days`;
}

/** True after the pause, or when the local date changed. */
export function isTimeNoteDue(timezone: IanaTimezone, previous: Date, now: Date): boolean {
  if (now.getTime() - previous.getTime() >= TIME_NOTE_PAUSE_MS) return true;
  const here = inZone(timezone);

  return here.day(previous) !== here.day(now);
}

/**
 * `Sat Nov 21, 14:05`. The send stamp holds the date too: compaction can remove the last full
 * note, and a message from before #1802 has no note.
 */
function formatSendStamp(timezone: IanaTimezone, at: Date): string {
  const clock = inZone(timezone).clock(at);

  return `${clock.weekday.slice(0, 3)} ${formatDay(clock.localDate, "short")}, ${formatHourMinute(clock)}`;
}

/**
 * The time note of a user message. The first message of a thread, and a message after a pause
 * or a date change, get the full note. Every other message gets the short form, the send stamp
 * `<sent>Sat Nov 21, 14:05</sent>` (amendment (e)). Thus the model sees each gap and knows the
 * time when its reply starts.
 */
export function messageTimeNote(args: {
  timezone: IanaTimezone;
  sentAt: Date;
  previousAt: Date | undefined;
}): string {
  const sent = formatLocalInstant(args.timezone, args.sentAt);

  if (args.previousAt === undefined) {
    return `<time_note>Sent ${sent}. This is the first message of the conversation.</time_note>`;
  }

  if (!isTimeNoteDue(args.timezone, args.previousAt, args.sentAt)) {
    return `<sent>${formatSendStamp(args.timezone, args.sentAt)}</sent>`;
  }

  const elapsed = formatElapsed(args.sentAt.getTime() - args.previousAt.getTime());

  return `<time_note>Sent ${sent}, ${elapsed} after the previous message.</time_note>`;
}

/**
 * The note of a new attempt at a user message, for example a retry after a failed run. The saved
 * note gives the send time, so a late attempt must say that time has passed. Null when the attempt
 * comes before the pause, on the same local date.
 */
export function retryTimeNote(args: {
  timezone: IanaTimezone;
  sentAt: Date;
  now: Date;
}): string | null {
  if (!isTimeNoteDue(args.timezone, args.sentAt, args.now)) return null;
  const elapsed = formatElapsed(args.now.getTime() - args.sentAt.getTime());

  return `Time note: it is now ${formatLocalInstant(args.timezone, args.now)}. This reply is a new attempt, ${elapsed} after the user sent the message.`;
}

/** The note of a run that continues after a long park, or after the local date changed. */
export function resumeTimeNote(args: {
  timezone: IanaTimezone;
  now: Date;
  runStartedAt: Date | undefined;
  wait: { kind: ParkWait; since: Date } | undefined;
}): string {
  const sentences = [`Time note: it is now ${formatLocalInstant(args.timezone, args.now)}.`];

  sentences.push(
    args.wait
      ? `This reply waited ${formatElapsed(args.now.getTime() - args.wait.since.getTime())} for ${WAIT_TEXT[args.wait.kind]}.`
      : "The local date changed while this reply ran.",
  );

  if (args.runStartedAt) {
    sentences.push(
      `The reply started ${formatElapsed(args.now.getTime() - args.runStartedAt.getTime())} ago.`,
    );
  }

  return sentences.join(" ");
}

/**
 * The saved contexts of these user messages. A row that fails the parse is a fault, so it
 * throws: a silent skip would change the replayed bytes.
 */
export async function loadTurnContexts(
  ex: AgentDbExecutor,
  userId: string,
  messageIds: readonly string[],
): Promise<Map<string, ChatTurnContext>> {
  if (messageIds.length === 0) return new Map();

  const rows = await ex
    .select({ messageId: chatTurnContexts.messageId, context: chatTurnContexts.context })
    .from(chatTurnContexts)
    .where(
      and(
        eq(chatTurnContexts.userId, userId),
        inArray(chatTurnContexts.messageId, [...messageIds]),
      ),
    );

  return new Map(rows.map((row) => [row.messageId, chatTurnContextSchema.parse(row.context)]));
}

/**
 * Save the context of a user message at admission, at the state of that moment. A second
 * writer loses to the first, so a double submit replays the first bytes.
 */
export async function captureTurnContext(args: {
  ex: AgentDbExecutor;
  userId: string;
  threadId: string;
  artifactTargetId: string | undefined;
  message: Pick<ChatMessage, "id" | "createdAt">;
  previousAt: Date | undefined;
}): Promise<ChatTurnContext> {
  const timezone = await settings({ userId: args.userId }).timezone();

  const artifacts = await buildThreadArtifactsContext(
    args.userId,
    args.threadId,
    args.artifactTargetId,
  );

  const context: ChatTurnContext = {
    timeNote: messageTimeNote({
      timezone,
      sentAt: args.message.createdAt,
      previousAt: args.previousAt,
    }),
    artifact:
      artifacts.threadFacts.length > 0
        ? { facts: artifacts.threadFacts, reference: artifacts.reference }
        : null,
  };

  await args.ex
    .insert(chatTurnContexts)
    .values({ messageId: args.message.id, userId: args.userId, context })
    .onConflictDoNothing();

  const saved = await loadTurnContexts(args.ex, args.userId, [args.message.id]);

  return saved.get(args.message.id) ?? context;
}

/**
 * Render saved contexts in thread order. A body shows only where its row version first appears
 * in the replayed window. The window changes only at compaction, which replaces the prefix and
 * its cache in any case.
 */
export function turnContextRenderer(): (context: ChatTurnContext) => string {
  const shown = new Map<string, number>();

  return (context) => {
    const blocks: string[] = [];

    if (context.artifact) {
      const lines = [context.artifact.facts];
      const reference = context.artifact.reference;

      if (reference && shown.get(reference.artifactId) === reference.rowVersion) {
        lines.push(
          `The selected artifact ${reference.artifactId} is unchanged since its copy above (rowVersion ${reference.rowVersion}).`,
        );
      } else if (reference) {
        lines.push(reference.text);
        shown.set(reference.artifactId, reference.rowVersion);
      }

      blocks.push(`<artifact_context>\n${lines.join("\n\n")}\n</artifact_context>`);
    }

    blocks.push(context.timeNote);

    return blocks.join("\n\n");
  };
}

/** Put the rendered context after the user's own content, in the same message. */
export function withTurnContext(
  content: StoredUserMessage["content"],
  text: string,
): StoredUserMessage["content"] {
  if (text.length === 0) return content;

  if (Array.isArray(content)) return [...content, { type: "text", text }];

  return content.length > 0 ? `${content}\n\n${text}` : text;
}

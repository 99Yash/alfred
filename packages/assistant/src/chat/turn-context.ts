import type { StoredUserMessage, TranscriptMessage } from "@alfred/ai";
import {
  collapseWhitespace,
  escapeHtml,
  escapeMarkupText,
  type IanaTimezone,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import type { ArtifactVersion, ChatMessage } from "@alfred/db/schemas";
import { artifactVersions, chatMessages, chatTurnContexts } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { buildArtifactReference, buildThreadArtifactsContext } from "@alfred/assistant/artifacts";
import type { AgentDbExecutor } from "@alfred/assistant/execution";
import {
  chatExchangeKey,
  chatExchangeRefSchema,
  chatTurnExcerpt,
  readChatExchangeTurns,
  recallChatExchanges,
  type ChatExchangeTurn,
} from "@alfred/assistant/knowledge";
import { settings } from "@alfred/assistant/settings";
import { formatDay, formatHourMinute, inZone } from "@alfred/assistant/time";
import { chatMessageIdOf, taggedUserMessage, withoutChatMessageTag } from "./chat-message-tag";

/**
 * The turn context (ADR-0130 decision 7, amendments (f) and (g)): the time note, the selected
 * artifact, and the chat-time recall of one user message. Admission saves the first two once; the
 * first step of the run saves the recall once. The prompt is a projection of
 * them: after the final replay window is set, each user message gets its rendered context after
 * the user's own text. For a fixed window the bytes do not change, so the cache holds.
 */

/**
 * A user message, or a run that continues, after this pause gets a time note. The eval of
 * ADR-0130 decision 7 sets the final value.
 */
export const TIME_NOTE_PAUSE_MS = 30 * 60_000;

/** One stored version of an artifact (`artifact_versions`). */
const artifactVersionRefSchema = z.object({
  artifactId: z.string(),
  rowVersion: z.number().int(),
});

type ArtifactVersionRef = z.infer<typeof artifactVersionRefSchema>;

/** One past exchange that chat-time recall found for a user message (journal.md section 5). */
const recalledExchangeSchema = chatExchangeRefSchema.extend({
  /** The local day of the past user message, in the zone of the recall, so the replay is stable. */
  sentOn: z.string(),
  /**
   * The user had deleted the thread at the time of the recall (journal.md section 3): the local day
   * of the delete, and the thread title. A delete keeps its first time and a deleted thread takes no
   * rename, so both are stable. Saved, not read live, so a later delete does not change the bytes
   * of an earlier prompt. Absent when the thread was live.
   */
  deleted: z.object({ on: z.string(), title: z.string().nullable() }).optional(),
});

export type RecalledExchange = z.infer<typeof recalledExchangeSchema>;

/** The `chat_turn_contexts.context` column. The column is untyped, so each read parses. */
export const chatTurnContextSchema = z.object({
  /** The `<time_note>` at the first message, after a pause, or at a date change. Else none. */
  timeNote: z.string().nullable(),
  /** Null when the thread had no artifact. */
  artifact: z
    .object({
      facts: z.string(),
      version: artifactVersionRefSchema.nullable(),
    })
    .nullable(),
  /**
   * Chat-time recall: past exchanges from other threads, nearest first. Written once, by the
   * first step of the run, because the search embeds the message and admission must not wait on
   * a provider. Absent when no recall ran (an older row, or a failed search). Empty when it found
   * nothing.
   */
  recall: z.array(recalledExchangeSchema).optional(),
});

export type ChatTurnContext = z.infer<typeof chatTurnContextSchema>;

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

/** True when the local date of `previous` and `now` differ. */
export function isNewLocalDate(timezone: IanaTimezone, previous: Date, now: Date): boolean {
  const here = inZone(timezone);

  return here.day(previous) !== here.day(now);
}

/** True after the pause, or when the local date changed. */
export function isTimeNoteDue(timezone: IanaTimezone, previous: Date, now: Date): boolean {
  if (now.getTime() - previous.getTime() >= TIME_NOTE_PAUSE_MS) return true;

  return isNewLocalDate(timezone, previous, now);
}

/**
 * The saved time note of a user message (amendment (f)): at the first message of a thread, after
 * a pause of {@link TIME_NOTE_PAUSE_MS} or more since the user's previous message, or on a new
 * local date. Null for any other message: it carries no time.
 */
export function messageTimeNote(args: {
  timezone: IanaTimezone;
  sentAt: Date;
  /** The send time of the user's previous message in the thread. An assistant row does not count. */
  previousUserAt: Date | undefined;
}): string | null {
  const sent = formatLocalInstant(args.timezone, args.sentAt);

  if (args.previousUserAt === undefined) {
    return `<time_note>Sent ${sent}. This is the first message of the conversation.</time_note>`;
  }

  if (!isTimeNoteDue(args.timezone, args.previousUserAt, args.sentAt)) return null;
  const elapsed = formatElapsed(args.sentAt.getTime() - args.previousUserAt.getTime());

  return `<time_note>Sent ${sent}, ${elapsed} after the user's previous message.</time_note>`;
}

/**
 * The note of a run whose first step starts late: a queued run, or a new attempt (a retry) at a
 * message that an earlier run took. The anchor is the send time, not the time of admission.
 */
export function startTimeNote(args: { timezone: IanaTimezone; now: Date; sentAt: Date }): string {
  const elapsed = formatElapsed(args.now.getTime() - args.sentAt.getTime());

  return `Time note: it is now ${formatLocalInstant(args.timezone, args.now)}. This reply started ${elapsed} after the user sent the message.`;
}

/**
 * The note of a run that continues: after a long park, after a long step, or after the local date
 * changed while the reply ran.
 */
export function resumeTimeNote(args: {
  timezone: IanaTimezone;
  now: Date;
  runStartedAt: Date | undefined;
  wait: { kind: ParkWait; since: Date } | undefined;
  /** The start of the previous model step, when that step was long ago. */
  previousStepAt: Date | undefined;
}): string {
  const sentences = [`Time note: it is now ${formatLocalInstant(args.timezone, args.now)}.`];

  if (args.wait) {
    sentences.push(
      `This reply waited ${formatElapsed(args.now.getTime() - args.wait.since.getTime())} for ${WAIT_TEXT[args.wait.kind]}.`,
    );
  } else if (args.previousStepAt) {
    sentences.push(
      `The previous step of this reply started ${formatElapsed(args.now.getTime() - args.previousStepAt.getTime())} ago.`,
    );
  } else {
    sentences.push("The local date changed while this reply ran.");
  }

  if (args.runStartedAt) {
    sentences.push(
      `The reply started ${formatElapsed(args.now.getTime() - args.runStartedAt.getTime())} ago.`,
    );
  }

  return sentences.join(" ");
}

/**
 * The past exchanges that chat-time recall gives the model for one message. The evals set the
 * final value for each case (owner, 2026-11-24). No similarity floor: a floor is a tuning rule.
 */
export const CHAT_RECALL_LIMIT = 3;

/** The characters of a recalled user message and of a recalled reply that the model sees. */
const RECALLED_USER_TURN_MAX_CHARS = 1_000;

const RECALLED_REPLY_MAX_CHARS = 1_500;

/** The saved values of some user messages, the artifact versions and the past turns that they name. */
interface SavedTurnContexts {
  contexts: Map<string, ChatTurnContext>;
  versions: Map<string, ArtifactVersion>;
  /** Keyed by `chatExchangeKey`. A deleted past thread has no entry. */
  recalled: Map<string, ChatExchangeTurn>;
}

function versionKey(ref: ArtifactVersionRef): string {
  return `${ref.artifactId}@${ref.rowVersion}`;
}

/**
 * The saved contexts of these user messages, and their artifact versions. A row that fails the
 * parse is a fault, so it throws: a silent skip would change the replayed bytes.
 */
async function loadSavedTurnContexts(
  ex: AgentDbExecutor,
  userId: string,
  messageIds: readonly string[],
): Promise<SavedTurnContexts> {
  const saved: SavedTurnContexts = {
    contexts: new Map(),
    versions: new Map(),
    recalled: new Map(),
  };

  if (messageIds.length === 0) return saved;

  const rows = await ex
    .select({ messageId: chatTurnContexts.messageId, context: chatTurnContexts.context })
    .from(chatTurnContexts)
    .where(
      and(
        eq(chatTurnContexts.userId, userId),
        inArray(chatTurnContexts.messageId, [...messageIds]),
      ),
    );

  const refs = new Map<string, ArtifactVersionRef>();
  const recalledRefs: RecalledExchange[] = [];

  for (const row of rows) {
    const context = chatTurnContextSchema.parse(row.context);
    saved.contexts.set(row.messageId, context);
    const version = context.artifact?.version;

    if (version) refs.set(versionKey(version), version);
    recalledRefs.push(...(context.recall ?? []));
  }

  saved.recalled = await loadRecalledTurns(userId, recalledRefs);

  if (refs.size === 0) return saved;

  const versions = await ex
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.userId, userId),
        or(
          ...[...refs.values()].map((ref) =>
            and(
              eq(artifactVersions.artifactId, ref.artifactId),
              eq(artifactVersions.rowVersion, ref.rowVersion),
            ),
          ),
        ),
      ),
    );

  for (const version of versions) saved.versions.set(versionKey(version), version);

  return saved;
}

/**
 * Save the context of a user message at admission, at the state of that moment, in the
 * admission transaction. The selected artifact version is stored once. A second writer loses to
 * the first, so a double submit keeps the first values.
 */
export async function captureTurnContext(args: {
  ex: AgentDbExecutor;
  userId: string;
  threadId: string;
  artifactTargetId: string | undefined;
  message: Pick<ChatMessage, "id" | "createdAt">;
  /** The send time of the user's previous message in the thread, if any. */
  previousUserAt: Date | undefined;
}): Promise<void> {
  const [existing] = await args.ex
    .select({ messageId: chatTurnContexts.messageId })
    .from(chatTurnContexts)
    .where(
      and(
        eq(chatTurnContexts.userId, args.userId),
        eq(chatTurnContexts.messageId, args.message.id),
      ),
    )
    .limit(1);

  // A new attempt at the message keeps the values of the first.
  if (existing) return;
  const timezone = await settings({ userId: args.userId, exec: args.ex }).timezone();

  const artifacts = await buildThreadArtifactsContext(
    args.ex,
    args.userId,
    args.threadId,
    args.artifactTargetId,
  );

  const selected = artifacts.selected;

  if (selected) {
    await args.ex
      .insert(artifactVersions)
      .values({
        artifactId: selected.id,
        rowVersion: selected.rowVersion,
        userId: args.userId,
        title: selected.title,
        kind: selected.kind,
        format: selected.format,
        status: selected.status,
        content: selected.content,
      })
      .onConflictDoNothing();
  }

  const context: ChatTurnContext = {
    timeNote: messageTimeNote({
      timezone,
      sentAt: args.message.createdAt,
      previousUserAt: args.previousUserAt,
    }),
    artifact:
      artifacts.threadFacts.length > 0
        ? {
            facts: artifacts.threadFacts,
            version: selected ? { artifactId: selected.id, rowVersion: selected.rowVersion } : null,
          }
        : null,
  };

  await args.ex
    .insert(chatTurnContexts)
    .values({ messageId: args.message.id, userId: args.userId, context })
    .onConflictDoNothing();
}

/**
 * Render saved contexts in window order. A body shows only where its version first appears in
 * the window. A later message with the same version shows one line that points to that copy.
 */
function turnContextRenderer(saved: SavedTurnContexts): (context: ChatTurnContext) => string {
  const shown = new Map<string, number>();

  return (context) => {
    const blocks: string[] = [];

    if (context.artifact) {
      const lines = [context.artifact.facts];
      const ref = context.artifact.version;
      const version = ref ? saved.versions.get(versionKey(ref)) : undefined;

      if (ref && shown.get(ref.artifactId) === ref.rowVersion) {
        lines.push(
          `The selected artifact ${ref.artifactId} is unchanged since its copy above (rowVersion ${ref.rowVersion}).`,
        );
      } else if (ref && version) {
        lines.push(
          buildArtifactReference({
            id: version.artifactId,
            title: version.title,
            kind: version.kind,
            format: version.format,
            status: version.status,
            rowVersion: version.rowVersion,
            content: version.content,
          }),
        );
        shown.set(ref.artifactId, ref.rowVersion);
      } else if (ref) {
        // Only an artifact delete removes a stored version.
        lines.push(
          `The body of artifact ${ref.artifactId} at rowVersion ${ref.rowVersion} is no longer stored.`,
        );
      }

      blocks.push(`<artifact_context>\n${lines.join("\n\n")}\n</artifact_context>`);
    }

    const recalled = renderRecalledChats(context.recall ?? [], saved.recalled);

    if (recalled !== undefined) blocks.push(recalled);

    if (context.timeNote !== null) blocks.push(context.timeNote);

    return blocks.join("\n\n");
  };
}

/**
 * The stored turns that saved recalls name. They are read from the messages, not from a copy. A
 * thread delete is a soft delete, so a deleted past thread stays in the replay with the mark that
 * the recall saved. Recall is optional, so a failed read renders no recall and the turn goes on.
 */
async function loadRecalledTurns(
  userId: string,
  refs: readonly RecalledExchange[],
): Promise<Map<string, ChatExchangeTurn>> {
  try {
    return await readChatExchangeTurns(userId, refs);
  } catch (err) {
    logger.warn(
      { err },
      "[chat-turn] recalled chats failed to load; the turn goes on without them",
    );

    return new Map();
  }
}

/** A value for a tag attribute: one line, with the markup characters encoded. */
function attributeText(value: string): string {
  return escapeHtml(collapseWhitespace(value));
}

/**
 * The `<recalled_chats>` block, or none when no recalled exchange is still stored. A user turn is
 * the user's own words. A reply is Alfred's own output and names its model: it is not evidence. A
 * chat that the user deleted carries the day of the delete and its title.
 */
export function renderRecalledChats(
  recall: readonly RecalledExchange[],
  turns: ReadonlyMap<string, ChatExchangeTurn>,
): string | undefined {
  const chats: string[] = [];

  for (const entry of recall) {
    const turn = turns.get(chatExchangeKey(entry));

    if (!turn) continue;
    // No live thread title: a rename would change the bytes of an earlier prompt. A deleted chat
    // shows the title that the recall saved, so the model can name it. The text is encoded,
    // so a past message that quotes a runtime tag cannot close this block or change a speaker.
    const user = escapeMarkupText(chatTurnExcerpt(turn.user.content, RECALLED_USER_TURN_MAX_CHARS));

    const deleted = entry.deleted
      ? ` deleted="${attributeText(entry.deleted.on)}"${entry.deleted.title === null ? "" : ` title="${attributeText(entry.deleted.title)}"`}`
      : "";

    const lines = [
      `<past_chat thread="${attributeText(turn.threadId)}" sent="${attributeText(entry.sentOn)}"${deleted}>`,
      `<user message="${attributeText(turn.user.id)}">${user}</user>`,
    ];

    const reply = escapeMarkupText(chatTurnExcerpt(turn.reply.content, RECALLED_REPLY_MAX_CHARS));

    if (reply.length > 0) {
      const model = turn.reply.models.length > 0 ? turn.reply.models.join(", ") : "not recorded";

      const status =
        turn.reply.status === "complete" ? "" : ` status="${attributeText(turn.reply.status)}"`;

      lines.push(
        `<alfred message="${attributeText(turn.reply.id)}" model="${attributeText(model)}"${status}>${reply}</alfred>`,
      );
    }

    lines.push("</past_chat>");
    chats.push(lines.join("\n"));
  }

  if (chats.length === 0) return undefined;

  return `<recalled_chats>\n${chats.join("\n")}\n</recalled_chats>`;
}

/**
 * Chat-time recall (journal.md section 5, net 2): search the run's user message against past
 * exchanges in other threads, and save the hits in its turn context. Write-once, as the other
 * values: a row that already has a recall keeps it, so a retried step replays the same bytes.
 * Only the first step of a run calls it, so a run that started before this field keeps its bytes.
 * An exchange that an earlier message of this thread recalled is not recalled again, so the
 * replay window carries each past exchange one time.
 * Recall is optional: it never throws. A failure saves nothing, the turn goes on with no recall,
 * and the warn log records it.
 */
export async function saveTurnRecall(args: {
  userId: string;
  threadId: string;
  messageId: string;
  timezone: IanaTimezone;
  abortSignal?: AbortSignal;
}): Promise<void> {
  try {
    const [row] = await db()
      .select({ context: chatTurnContexts.context, content: chatMessages.content })
      .from(chatTurnContexts)
      .innerJoin(chatMessages, eq(chatMessages.id, chatTurnContexts.messageId))
      .where(
        and(
          eq(chatTurnContexts.userId, args.userId),
          eq(chatTurnContexts.messageId, args.messageId),
        ),
      )
      .limit(1);

    if (!row || chatTurnContextSchema.parse(row.context).recall !== undefined) return;

    const hits = await recallChatExchanges({
      userId: args.userId,
      query: row.content,
      excludeThreadId: args.threadId,
      excludeUserMessageIds: await threadRecalledUserMessageIds(args),
      limit: CHAT_RECALL_LIMIT,
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    });

    const here = inZone(args.timezone);

    const recall: RecalledExchange[] = hits.map((hit) => ({
      userMessageId: hit.user.id,
      replyMessageId: hit.reply.id,
      sentOn: formatDay(here.clock(hit.user.createdAt).localDate, "long"),
      ...(hit.threadDeletedAt
        ? {
            deleted: {
              on: formatDay(here.clock(hit.threadDeletedAt).localDate, "long"),
              title: hit.threadTitle,
            },
          }
        : {}),
    }));

    await db()
      .update(chatTurnContexts)
      .set({
        context: sql`jsonb_set(${chatTurnContexts.context}, '{recall}', ${JSON.stringify(recall)}::jsonb)`,
      })
      .where(
        and(
          eq(chatTurnContexts.userId, args.userId),
          eq(chatTurnContexts.messageId, args.messageId),
          sql`NOT (${chatTurnContexts.context} ? 'recall')`,
        ),
      );
  } catch (err) {
    logger.warn(
      { err, messageId: args.messageId },
      "[chat-turn] chat-time recall failed; the turn goes on without it",
    );
  }
}

/** The past user messages that earlier recalls of this thread already gave the model. */
async function threadRecalledUserMessageIds(args: {
  userId: string;
  threadId: string;
  messageId: string;
}): Promise<string[]> {
  const rows = await db()
    .select({ context: chatTurnContexts.context })
    .from(chatTurnContexts)
    .innerJoin(chatMessages, eq(chatMessages.id, chatTurnContexts.messageId))
    .where(
      and(
        eq(chatTurnContexts.userId, args.userId),
        eq(chatMessages.threadId, args.threadId),
        ne(chatTurnContexts.messageId, args.messageId),
        sql`${chatTurnContexts.context} ? 'recall'`,
      ),
    );

  const ids = new Set<string>();

  for (const row of rows) {
    for (const entry of chatTurnContextSchema.parse(row.context).recall ?? []) {
      ids.add(entry.userMessageId);
    }
  }

  return [...ids];
}

/** Put the rendered context after the user's own content, in the same message. */
function withTurnContext(
  content: StoredUserMessage["content"],
  text: string,
): StoredUserMessage["content"] {
  if (text.length === 0) return content;

  if (Array.isArray(content)) return [...content, { type: "text", text }];

  return content.length > 0 ? `${content}\n\n${text}` : text;
}

/** Maps a replay window to the model view. Pure, so a guard can call it on each candidate. */
export type TurnContextProjection = (window: readonly TranscriptMessage[]) => TranscriptMessage[];

/**
 * Load the saved contexts of the tagged user messages in `transcript`, and of the run's own
 * message, and return the projection (amendment (g)). Call it on the final replay window: after
 * the background summary, the foreground guard, and compaction inside a run.
 *
 * - Each tagged user message gets its rendered context after the user's text, and loses its tag.
 * - Compaction inside a run summarizes the run's own message away. Its context then goes in a
 *   user message after the leading summary, so the model keeps the artifact body and the hash.
 * - A user message that is still empty after the projection is dropped.
 */
export async function loadTurnContextProjection(args: {
  userId: string;
  transcript: readonly TranscriptMessage[];
  ownMessageId: string | undefined;
}): Promise<TurnContextProjection> {
  const ids = new Set<string>();

  for (const message of args.transcript) {
    const id = chatMessageIdOf(message);

    if (id !== undefined) ids.add(id);
  }

  if (args.ownMessageId !== undefined) ids.add(args.ownMessageId);
  const saved = await loadSavedTurnContexts(db(), args.userId, [...ids]);

  return (window) => {
    const own = args.ownMessageId;
    let entries = [...window];

    if (
      own !== undefined &&
      saved.contexts.has(own) &&
      !window.some((message) => chatMessageIdOf(message) === own)
    ) {
      const at = window[0]?.role === "system" ? 1 : 0;
      entries = [...window.slice(0, at), taggedUserMessage(own, ""), ...window.slice(at)];
    }

    const render = turnContextRenderer(saved);
    const out: TranscriptMessage[] = [];

    for (const message of entries) {
      const id = chatMessageIdOf(message);

      if (id === undefined || message.role !== "user") {
        out.push(message);
        continue;
      }

      const context = saved.contexts.get(id);
      const content = context ? withTurnContext(message.content, render(context)) : message.content;

      if (content.length === 0) continue;
      out.push({ ...withoutChatMessageTag(message), content });
    }

    return out;
  };
}

/**
 * The rendered context of each of these user messages, rendered in the given (thread) order, for
 * a size estimate that reads rows and not a transcript (the background compaction scheduler).
 */
export async function renderedTurnContexts(
  userId: string,
  messageIds: readonly string[],
): Promise<Map<string, string>> {
  const saved = await loadSavedTurnContexts(db(), userId, messageIds);
  const render = turnContextRenderer(saved);
  const rendered = new Map<string, string>();

  for (const id of messageIds) {
    const context = saved.contexts.get(id);

    if (context) rendered.set(id, render(context));
  }

  return rendered;
}

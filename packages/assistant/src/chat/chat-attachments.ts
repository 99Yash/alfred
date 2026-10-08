import {
  isPassThrough,
  isRecord,
  MAX_MODEL_ATTACHMENT_BYTES_PER_TURN,
  toMessage,
  type AgentTranscriptMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments, chatMessages } from "@alfred/db/schemas";
import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { readObject, sniffPassThroughImageMime } from "./attachments";
import type { AgentDbExecutor } from "@alfred/assistant/execution";

/**
 * Chat transcript attachments (ADR-0065). The stored transcript holds object keys,
 * never bytes; bytes are inlined per request under a per-turn budget.
 * A dropped image becomes a text part that says why, so no drop is silent.
 */

/** A `ready` attachment as the transcript builder needs it. */
export interface ReadyAttachment {
  id: string;
  storageKey: string;
  mime: string;
  size: number;
  degradedText: string | null;
  degradedImageKeys: string[];
}

const CHAT_ATTACHMENT_IMAGE_PART = "chat_attachment_image";

interface StoredChatAttachmentImagePart {
  type: typeof CHAT_ATTACHMENT_IMAGE_PART;
  storageKey: string;
  attachmentId?: string;
  mediaType?: string;
  byteSize?: number;
}

type StoredChatContentPart = { type: "text"; text: string } | StoredChatAttachmentImagePart;

export interface AttachmentHydrationBudget {
  usedEncodedBytes: number;
  skippedImages: number;
  unreadableImages: number;
  invalidImages: number;
}

interface HydratedAttachmentImage {
  image: string;
  mediaType: string;
  encodedBytes: number;
}

/** Injectable for tests; production uses {@link readObject}. */
export type StoredObjectReader = (storageKey: string) => Promise<Uint8Array>;

function storedAttachmentImagePart(
  storageKey: string,
  mediaType?: string,
  attachmentId?: string,
  byteSize?: number,
): StoredChatAttachmentImagePart {
  return {
    type: CHAT_ATTACHMENT_IMAGE_PART,
    storageKey,
    ...(attachmentId ? { attachmentId } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(byteSize !== undefined ? { byteSize } : {}),
  };
}

function isStoredAttachmentImagePart(value: unknown): value is StoredChatAttachmentImagePart {
  return (
    isRecord(value) &&
    value.type === CHAT_ATTACHMENT_IMAGE_PART &&
    typeof value.storageKey === "string" &&
    (value.attachmentId === undefined || typeof value.attachmentId === "string") &&
    (value.mediaType === undefined || typeof value.mediaType === "string") &&
    (value.byteSize === undefined ||
      (typeof value.byteSize === "number" &&
        Number.isFinite(value.byteSize) &&
        value.byteSize >= 0))
  );
}

/** Load `ready` attachments by message id. Skipping `pending` keeps a slow degrade from blocking the turn. */
export async function loadReadyAttachments(
  userId: string,
  messageIds: string[],
  ex: AgentDbExecutor = db(),
): Promise<Map<string, ReadyAttachment[]>> {
  const byMessage = new Map<string, ReadyAttachment[]>();

  if (messageIds.length === 0) return byMessage;

  const rows = await ex
    .select({
      id: chatAttachments.id,
      messageId: chatAttachments.messageId,
      storageKey: chatAttachments.storageKey,
      mime: chatAttachments.mime,
      size: chatAttachments.size,
      degradedText: chatAttachments.degradedText,
      degradedImageKeys: chatAttachments.degradedImageKeys,
    })
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.userId, userId),
        inArray(chatAttachments.messageId, messageIds),
        eq(chatAttachments.status, "ready"),
      ),
    )
    .orderBy(
      asc(chatAttachments.position),
      asc(chatAttachments.createdAt),
      asc(chatAttachments.id),
    );

  for (const r of rows) {
    const list = byMessage.get(r.messageId) ?? [];
    list.push({
      id: r.id,
      storageKey: r.storageKey,
      mime: r.mime,
      size: r.size,
      degradedText: r.degradedText,
      degradedImageKeys: r.degradedImageKeys,
    });
    byMessage.set(r.messageId, list);
  }

  return byMessage;
}

/**
 * Whether this turn and older turns carry images (ADR-0072). The thread replays each
 * turn, so an old image can fail a new turn, and only a new chat removes it.
 * "Counts as an image" must match {@link buildStoredContentParts}.
 */
export async function threadImageAttachments(
  userId: string,
  threadId: string,
  currentUserMessageId: string | undefined,
): Promise<{ currentTurn: boolean; historical: boolean }> {
  const rows = await db()
    .select({ messageId: chatAttachments.messageId })
    .from(chatAttachments)
    .innerJoin(chatMessages, eq(chatAttachments.messageId, chatMessages.id))
    .where(
      and(
        eq(chatMessages.userId, userId),
        eq(chatMessages.threadId, threadId),
        eq(chatAttachments.status, "ready"),
        or(
          like(chatAttachments.mime, "image/%"),
          sql`jsonb_array_length(${chatAttachments.degradedImageKeys}) > 0`,
        ),
      ),
    );

  let currentTurn = false;
  let historical = false;

  for (const r of rows) {
    if (currentUserMessageId && r.messageId === currentUserMessageId) currentTurn = true;
    else historical = true;
  }

  return { currentTurn, historical };
}

/** Text first, then each attachment's parts, as keys. {@link hydrateTranscriptForModel} inlines the bytes. */
export function buildStoredContentParts(
  text: string,
  attachments: ReadyAttachment[],
): StoredChatContentPart[] {
  const parts: StoredChatContentPart[] = [];

  if (text.length > 0) parts.push({ type: "text", text });

  for (const a of attachments) {
    if (isPassThrough(a.mime)) {
      parts.push(storedAttachmentImagePart(a.storageKey, a.mime, a.id, a.size));
      continue;
    }

    if (a.degradedText && a.degradedText.length > 0) {
      parts.push({ type: "text", text: a.degradedText });
    }

    for (const key of a.degradedImageKeys) {
      parts.push(storedAttachmentImagePart(key));
    }
  }

  return parts;
}

/** The budget counts base64 size: 3 bytes become 4 characters. */
function encodedImageBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

class UnsupportedStoredImageError extends Error {
  constructor() {
    super("stored image bytes are not a supported image");
  }
}

async function hydrateAttachmentImage(
  part: StoredChatAttachmentImagePart,
  cache: Map<string, HydratedAttachmentImage>,
  readStoredObject: StoredObjectReader,
): Promise<HydratedAttachmentImage> {
  const cached = cache.get(part.storageKey);

  if (cached) return cached;
  const bytes = await readStoredObject(part.storageKey);
  const mediaType = part.mediaType ?? sniffPassThroughImageMime(bytes);

  if (!mediaType) throw new UnsupportedStoredImageError();

  const hydrated = {
    image: Buffer.from(bytes).toString("base64"),
    mediaType,
    encodedBytes: encodedImageBytes(bytes.byteLength),
  };

  cache.set(part.storageKey, hydrated);

  return hydrated;
}

async function hydrateContentForModel(
  content: unknown,
  budget: AttachmentHydrationBudget,
  cache: Map<string, HydratedAttachmentImage>,
  readStoredObject: StoredObjectReader,
): Promise<unknown> {
  if (!Array.isArray(content)) return content;
  const parts: unknown[] = [];

  for (const part of content) {
    if (!isStoredAttachmentImagePart(part)) {
      parts.push(part);
      continue;
    }

    // Providers cannot fetch our private URLs, so inline base64. A string, not a
    // Uint8Array: the fallback replays the same objects. Skip a known overflow before the read.
    const projectedEncodedBytes =
      part.byteSize !== undefined ? encodedImageBytes(part.byteSize) : null;

    if (
      projectedEncodedBytes !== null &&
      budget.usedEncodedBytes + projectedEncodedBytes > MAX_MODEL_ATTACHMENT_BYTES_PER_TURN
    ) {
      budget.skippedImages += 1;
      parts.push({
        type: "text",
        text: "[Image attachment omitted because the image context budget is full.]",
      });
      continue;
    }

    let hydrated: HydratedAttachmentImage;

    try {
      hydrated = await hydrateAttachmentImage(part, cache, readStoredObject);
    } catch (err) {
      if (err instanceof UnsupportedStoredImageError) {
        budget.invalidImages += 1;
        console.warn("[chat] skipped invalid attachment image:", toMessage(err));
        parts.push({
          type: "text",
          text: "[Image attachment omitted because it could not be processed.]",
        });
        continue;
      }

      budget.unreadableImages += 1;
      console.warn("[chat] skipped unreadable attachment image:", toMessage(err));
      parts.push({
        type: "text",
        text: "[Image attachment omitted because it could not be read.]",
      });
      continue;
    }

    // Check the real size too: `byteSize` can be missing or wrong.
    if (budget.usedEncodedBytes + hydrated.encodedBytes > MAX_MODEL_ATTACHMENT_BYTES_PER_TURN) {
      budget.skippedImages += 1;
      parts.push({
        type: "text",
        text: "[Image attachment omitted because the image context budget is full.]",
      });
      continue;
    }

    budget.usedEncodedBytes += hydrated.encodedBytes;
    parts.push({ type: "file", data: hydrated.image, mediaType: hydrated.mediaType });
  }

  return parts;
}

/**
 * Inline images newest first, so the latest turns win the budget. Message order is kept.
 * Warns here about drops, so no caller can forget to.
 */
export async function hydrateTranscriptForModel(
  transcript: readonly AgentTranscriptMessage[],
  readStoredObject: StoredObjectReader = readObject,
): Promise<{ transcript: AgentTranscriptMessage[]; budget: AttachmentHydrationBudget }> {
  const budget: AttachmentHydrationBudget = {
    usedEncodedBytes: 0,
    skippedImages: 0,
    unreadableImages: 0,
    invalidImages: 0,
  };

  const cache = new Map<string, HydratedAttachmentImage>();
  const reversed: AgentTranscriptMessage[] = [];

  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];

    if (!message) continue;
    reversed.push({
      ...message,
      content: await hydrateContentForModel(message.content, budget, cache, readStoredObject),
    });
  }

  warnOnSkippedAttachments(budget);

  return { transcript: reversed.reverse(), budget };
}

/** Warn once per skip reason for whatever the budget dropped this turn. */
function warnOnSkippedAttachments(budget: AttachmentHydrationBudget): void {
  if (budget.skippedImages > 0) {
    console.warn(
      "[chat] skipped attachment images over model budget:",
      JSON.stringify({
        skippedImages: budget.skippedImages,
        usedEncodedBytes: budget.usedEncodedBytes,
        maxBytes: MAX_MODEL_ATTACHMENT_BYTES_PER_TURN,
      }),
    );
  }

  if (budget.invalidImages > 0) {
    console.warn(
      "[chat] skipped invalid attachment images:",
      JSON.stringify({ invalidImages: budget.invalidImages }),
    );
  }

  if (budget.unreadableImages > 0) {
    console.warn(
      "[chat] skipped unreadable attachment images:",
      JSON.stringify({ unreadableImages: budget.unreadableImages }),
    );
  }
}

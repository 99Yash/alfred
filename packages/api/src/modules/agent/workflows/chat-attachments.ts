import {
  isPassThrough,
  isRecord,
  MAX_MODEL_ATTACHMENT_BYTES_PER_TURN,
  toMessage,
  type AgentTranscriptMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatAttachments } from "@alfred/db/schemas";
import { and, asc, eq, inArray } from "drizzle-orm";
import { sniffPassThroughImageMime } from "../../chat/attachments";
import { readObject } from "../../chat/storage";
import type { AgentDbExecutor } from "../types";

/**
 * The attachment half of the chat transcript (ADR-0065): what a stored message
 * carries, and how those stored references become model-ready content parts
 * immediately before each provider call.
 *
 * The durable transcript stores object *keys*, never bytes — a checkpoint full
 * of base64 images would be unusable, and the keys have to survive a park. So
 * hydration is a per-request step with a hard per-turn byte budget
 * ({@link MAX_MODEL_ATTACHMENT_BYTES_PER_TURN}) and three distinct ways an image
 * can be dropped: over budget, unreadable, or not a supported image. Each drop
 * substitutes a text part saying which, so the model never silently loses an
 * attachment it was told about.
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

/** Running per-turn accounting, and the tally behind the three skip warnings. */
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

/**
 * Reading an object's bytes back out of storage. Injectable so the budget
 * accounting and every skip reason are directly testable without object
 * storage; production resolves it to {@link readObject}.
 */
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

/**
 * Load the `ready` attachments for a set of messages, grouped by message id.
 * Only `ready` rows are folded into the model context — `pending` (still
 * degrading) and `failed` rows are skipped, so a slow degrade can't block the
 * turn (ADR-0065's bounded-await / graceful-partial posture).
 */
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
 * Build an AI-SDK content-parts array for a user message that has attachments:
 * the typed text first, then each attachment's contribution. The durable
 * transcript stores object keys, not bytes; {@link hydrateTranscriptForModel}
 * reads each object's bytes back and inlines them immediately before each model
 * call. A degraded modality (Phase 2/3) contributes its extracted `degradedText`
 * plus any keyframe images.
 */
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

/** Base64 expands 3 bytes to 4 characters; the budget is counted in those. */
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
    // Inline the bytes (ADR-0065 "bytes path") instead of a presigned URL: the
    // providers can't fetch our private, short-lived Railway storage URLs, so a
    // URL-valued image part fails the turn (boss + fallback alike). Encode as a
    // base64 string rather than a raw Uint8Array so the fallback cascade can
    // replay the same message objects without sharing mutable byte buffers.
    //
    // When the stored part declares its size, spend the budget check BEFORE the
    // read: an image already known to overflow is not worth fetching.
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
    // Re-check against the real encoded size: an undeclared `byteSize` skipped
    // the projection above, and a declared one is only the raw size the uploader
    // recorded.
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
 * Inline every stored attachment image in a transcript, newest message first, up
 * to the per-turn byte budget.
 *
 * The reverse order is the budget policy: when a long thread carries more image
 * bytes than one request may hold, the images the user is most likely asking
 * about — the ones on the latest turns — are the ones that survive. Messages are
 * returned in their original order.
 *
 * Returns the hydrated transcript alongside the budget it spent, so a caller can
 * report what was dropped without re-deriving it.
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
  return { transcript: reversed.reverse(), budget };
}

/** Warn once per skip reason for whatever the budget dropped this turn. */
export function warnOnSkippedAttachments(budget: AttachmentHydrationBudget): void {
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

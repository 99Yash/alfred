import { z } from "zod";

import type { JsonObject } from "./user-model";

export type AgentTranscriptRole = "system" | "user" | "assistant" | "tool";

/** The persisted message shape. `@alfred/ai` `parseStoredTranscript` gives it a typed `content`. */
export interface AgentTranscriptMessage {
  role: AgentTranscriptRole;
  content: unknown;
  providerOptions?: JsonObject | undefined;
}

/**
 * A chat image as the stored transcript keeps it (ADR-0065): an object key, never bytes. Only a
 * user message holds it, and the turn inlines the bytes before the model call.
 */
export const STORED_ATTACHMENT_IMAGE_PART = "chat_attachment_image";

export const storedAttachmentImagePartSchema = z.object({
  type: z.literal(STORED_ATTACHMENT_IMAGE_PART),
  storageKey: z.string(),
  attachmentId: z.string().optional(),
  mediaType: z.string().optional(),
  byteSize: z.number().nonnegative().optional(),
});

export type StoredAttachmentImagePart = z.infer<typeof storedAttachmentImagePartSchema>;

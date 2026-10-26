/**
 * The typed view of `agent_runs.transcript`. The column stores `AgentTranscriptMessage` (`content:
 * unknown`, ADR-0040 keeps `@alfred/db` free of `ai`). A step reads it through
 * {@link parseStoredTranscript} and from then on sees AI SDK messages, plus the stored chat image
 * part on a user message (ADR-0065). {@link toStoredTranscript} is the way back to the column.
 */

import {
  getStringPath,
  isRecord,
  jsonObjectSchema,
  toJsonValue,
  type AgentTranscriptMessage,
} from "@alfred/contracts";
import {
  InvalidPromptError,
  modelMessageSchema,
  userModelMessageSchema,
  type ModelMessage,
  type UserContent,
  type UserModelMessage,
} from "ai";
import { z } from "zod";

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

type UserPart = Exclude<UserContent, string>[number];

/** A user message as the transcript stores it: image parts hold an object key, not bytes. */
export type StoredUserMessage = Omit<UserModelMessage, "content"> & {
  content: string | (UserPart | StoredAttachmentImagePart)[];
};

export type TranscriptMessage = Exclude<ModelMessage, UserModelMessage> | StoredUserMessage;

/** The SDK schemas run on a copy where each stored image part is an empty text part. */
const STORED_IMAGE_STAND_IN = { type: "text", text: "" } as const;

function isTranscriptMessage(message: unknown): message is TranscriptMessage {
  if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) {
    return modelMessageSchema.safeParse(message).success;
  }

  const sdkContent: unknown[] = [];

  for (const part of message.content) {
    if (!isRecord(part) || part.type !== STORED_ATTACHMENT_IMAGE_PART) {
      sdkContent.push(part);
      continue;
    }

    if (!storedAttachmentImagePartSchema.safeParse(part).success) return false;
    sdkContent.push(STORED_IMAGE_STAND_IN);
  }

  return userModelMessageSchema.safeParse({ ...message, content: sdkContent }).success;
}

/**
 * The one read of a stored transcript. It checks each message with the AI SDK's own message
 * schemas, the same check the SDK runs before a call. Throws `InvalidPromptError`, as the SDK does,
 * on the first message that does not match.
 *
 * It returns the input objects, never the zod output: the SDK schemas strip unknown keys, so a
 * later commit of the output would delete provider keys from the row.
 */
export function parseStoredTranscript(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) {
    throw new InvalidPromptError({
      prompt: value,
      message: "The stored transcript is not an array.",
    });
  }

  const messages: TranscriptMessage[] = [];

  for (const [index, message] of value.entries()) {
    if (!isTranscriptMessage(message)) {
      throw new InvalidPromptError({
        prompt: value,
        message: `Transcript message ${index} (role ${getStringPath(message, "role")}) does not match the ModelMessage schema.`,
      });
    }

    messages.push(message);
  }

  return messages;
}

/**
 * The model view of a transcript. A stored image part must be inlined first (the chat turn does
 * that), so one that is still here throws `InvalidPromptError`.
 */
export function toModelMessages(transcript: readonly TranscriptMessage[]): ModelMessage[] {
  return transcript.map((message, index) => {
    if (message.role !== "user") return message;

    if (!Array.isArray(message.content)) return { ...message, content: message.content };

    const content: UserPart[] = [];

    for (const part of message.content) {
      if (part.type === STORED_ATTACHMENT_IMAGE_PART) {
        throw new InvalidPromptError({
          prompt: transcript,
          message: `Transcript message ${index} holds a stored image part that was not inlined.`,
        });
      }

      content.push(part);
    }

    return { ...message, content };
  });
}

/**
 * The column view of a transcript. Message-level `providerOptions` go through a JSON round trip,
 * which is what the jsonb column stores. Every other key is kept as is.
 */
export function toStoredTranscript(
  transcript: readonly TranscriptMessage[],
): AgentTranscriptMessage[] {
  return transcript.map(({ providerOptions, ...message }) =>
    providerOptions === undefined
      ? message
      : { ...message, providerOptions: jsonObjectSchema.parse(toJsonValue(providerOptions)) },
  );
}

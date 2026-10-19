/**
 * The two views of one transcript. `AgentTranscriptMessage` is the persisted, JSON view that the
 * run row stores (`content: unknown`). `ModelMessage` is the AI SDK view that a model call takes.
 */

import { jsonObjectSchema, toJsonValue, type AgentTranscriptMessage } from "@alfred/contracts";
import { InvalidPromptError, modelMessageSchema, type ModelMessage } from "ai";

function isModelMessage(
  message: AgentTranscriptMessage,
): message is AgentTranscriptMessage & ModelMessage {
  return modelMessageSchema.safeParse(message).success;
}

/**
 * The model view of a stored transcript. It checks each message with the AI SDK's own
 * `modelMessageSchema`, the same check the SDK runs before a call, and returns the same objects.
 * Throws `InvalidPromptError`, as the SDK does, on the first message that does not match.
 */
export function toModelMessages(transcript: readonly AgentTranscriptMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const [index, message] of transcript.entries()) {
    if (!isModelMessage(message)) {
      throw new InvalidPromptError({
        prompt: transcript,
        message: `Transcript message ${index} (role ${message.role}) does not match the ModelMessage schema.`,
      });
    }

    messages.push(message);
  }

  return messages;
}

/**
 * The stored view of messages from a model response. The content is kept as is. Message-level
 * `providerOptions` go through a JSON round trip, which is what the jsonb column stores.
 */
export function toTranscriptMessages(messages: readonly ModelMessage[]): AgentTranscriptMessage[] {
  return messages.map(({ role, content, providerOptions }) =>
    providerOptions === undefined
      ? { role, content }
      : { role, content, providerOptions: jsonObjectSchema.parse(toJsonValue(providerOptions)) },
  );
}

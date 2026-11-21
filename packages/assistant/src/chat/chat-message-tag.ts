import type { StoredUserMessage, TranscriptMessage } from "@alfred/ai";
import { getStringPath } from "@alfred/contracts";

/**
 * A replayed user message carries the id of its `chat_messages` row, so the projection can find
 * the turn context of each message after compaction moved the window (ADR-0130 amendment (g)). The
 * id rides a provider-options key that no provider reads, and the projection removes it before the
 * model call.
 */
const TAG_NAMESPACE = "alfred";

const TAG_KEY = "chatMessageId";

/** A user message of the chat transcript, tagged with its row id. */
export function taggedUserMessage(
  messageId: string,
  content: StoredUserMessage["content"],
): StoredUserMessage {
  return { role: "user", content, providerOptions: { [TAG_NAMESPACE]: { [TAG_KEY]: messageId } } };
}

/** The row id of a tagged user message, else `undefined`. */
export function chatMessageIdOf(message: TranscriptMessage | undefined): string | undefined {
  if (message?.role !== "user") return undefined;

  return getStringPath(message.providerOptions, TAG_NAMESPACE, TAG_KEY);
}

/** The user message with no tag. A message with no tag comes back as it is. */
export function withoutChatMessageTag(message: StoredUserMessage): StoredUserMessage {
  const { providerOptions, ...rest } = message;

  if (providerOptions?.[TAG_NAMESPACE] === undefined) return message;
  const { [TAG_NAMESPACE]: _tag, ...others } = providerOptions;

  return Object.keys(others).length > 0 ? { ...rest, providerOptions: others } : rest;
}

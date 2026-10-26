import { chatModelTierSchema, parsePersistedMetadata } from "@alfred/contracts";
import { z } from "zod";

/**
 * `agent_runs.metadata` on a chat-turn run. Admission writes every key; `createRun` parses it for
 * the workflow hooks, and the admission lookups read stored rows back. A leaf module, to avoid an
 * import cycle.
 */
export const chatTurnRunMetadataSchema = z.looseObject({
  threadId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  /** The thread-level dedup key: one live run per user message. */
  userMessageId: z.string().min(1),
  tier: chatModelTierSchema,
  artifactTargetId: z.string().min(1).optional(),
});

export type ChatTurnRunMetadataInput = z.input<typeof chatTurnRunMetadataSchema>;

export type ChatTurnRunMetadata = z.output<typeof chatTurnRunMetadataSchema>;

/** Lenient per key: a bad or missing field reads as absent and the caller picks the fallback. */
const storedChatTurnRunMetadataSchema = chatTurnRunMetadataSchema
  .partial()
  .brand<"ParsedChatTurnRunMetadata">();

type StoredChatTurnRunMetadata = z.output<typeof storedChatTurnRunMetadataSchema>;

export function readChatTurnRunMetadata(metadata: unknown): StoredChatTurnRunMetadata {
  return parsePersistedMetadata(storedChatTurnRunMetadataSchema, metadata);
}

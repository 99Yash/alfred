import type { JsonObject } from "./user-model";

export type AgentTranscriptRole = "system" | "user" | "assistant" | "tool";

/** The persisted message shape. `@alfred/ai` `parseStoredTranscript` gives it a typed `content`. */
export interface AgentTranscriptMessage {
  role: AgentTranscriptRole;
  content: unknown;
  providerOptions?: JsonObject | undefined;
}

import type { JsonObject } from "./user-model";

export type AgentTranscriptRole = "system" | "user" | "assistant" | "tool";

export interface AgentTranscriptMessage {
  role: AgentTranscriptRole;
  content: unknown;
  providerOptions?: JsonObject | undefined;
}

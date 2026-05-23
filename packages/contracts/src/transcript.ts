export type AgentTranscriptRole = "system" | "user" | "assistant" | "tool";

export interface AgentTranscriptMessage {
  role: AgentTranscriptRole;
  content: unknown;
  providerOptions?: Record<string, unknown>;
}

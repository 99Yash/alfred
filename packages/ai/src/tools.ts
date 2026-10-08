// Re-exported so app code can define tools without depending on `ai` directly.
export { isStepCount, streamText, tool } from "ai";

export type { LanguageModel, ModelMessage, Tool, ToolSet, TypedToolCall } from "ai";

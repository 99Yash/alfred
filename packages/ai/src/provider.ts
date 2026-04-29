import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export function getBossModel(): LanguageModel {
  return anthropic("claude-sonnet-4-6");
}

export function getSubAgentModel(): LanguageModel {
  return anthropic("claude-sonnet-4-6");
}

export function getCheapModel(): LanguageModel {
  return google("gemini-2.5-flash");
}

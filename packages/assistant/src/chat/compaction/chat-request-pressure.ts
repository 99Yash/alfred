import { asSchema, type FilePart, type ToolSet } from "ai";

import { parseJsonText, type JsonValue } from "@alfred/contracts";

import { effectiveInputWindowTokens, type TranscriptMessage } from "@alfred/ai";

import { estimateSerializedTokens } from "@alfred/assistant/execution";
import { CHAT_HYDRATED_IMAGE_TOKENS, CHAT_SYNC_COMPACTION_RATIO } from "./constants";

export interface ChatRequestTokenEstimate {
  systemTokens: number;
  toolTokens: number;
  transcriptTokens: number;
  hydratedImageTokens: number;
  inputTokens: number;
  outputReserveTokens: number;
  totalRequestTokens: number;
}

export interface ChatRequestPressure extends ChatRequestTokenEstimate {
  effectiveInputWindowTokens: number;
  synchronousCompactionThresholdTokens: number;
  requiresSynchronousCompaction: boolean;
}

/** Estimate the exact request surface assembled immediately before the call. */
export async function estimateChatRequestTokens({
  systemPrompt,
  tools,
  transcript,
  outputReserveTokens,
}: {
  systemPrompt: string;
  tools: ToolSet;
  transcript: readonly TranscriptMessage[];
  outputReserveTokens: number;
}): Promise<ChatRequestTokenEstimate> {
  if (!Number.isInteger(outputReserveTokens) || outputReserveTokens < 0) {
    throw new Error("outputReserveTokens must be a non-negative integer");
  }

  const canonicalTools = await Promise.all(
    Object.keys(tools)
      .sort((left, right) => left.localeCompare(right))
      .map(async (name) => {
        const definition = tools[name];

        if (!definition) return null;

        if (definition.type === "provider") {
          return { name, type: definition.type, id: definition.id, args: definition.args };
        }

        return {
          name,
          description: definition.description,
          inputSchema: await asSchema(definition.inputSchema).jsonSchema,
        };
      }),
  );

  const normalized = normalizeTranscript(transcript);
  const systemTokens = estimateSerializedTokens(systemPrompt);
  const toolTokens = estimateSerializedTokens(canonicalTools);
  const transcriptTokens = estimateSerializedTokens(normalized.messages);
  const hydratedImageTokens = normalized.hydratedImages * CHAT_HYDRATED_IMAGE_TOKENS;
  const inputTokens = systemTokens + toolTokens + transcriptTokens + hydratedImageTokens;

  return {
    systemTokens,
    toolTokens,
    transcriptTokens,
    hydratedImageTokens,
    inputTokens,
    outputReserveTokens,
    totalRequestTokens: inputTokens + outputReserveTokens,
  };
}

export async function assessChatRequestPressure(args: {
  systemPrompt: string;
  tools: ToolSet;
  transcript: readonly TranscriptMessage[];
  contextWindowTokens: number;
  outputReserveTokens: number;
}): Promise<ChatRequestPressure> {
  const estimate = await estimateChatRequestTokens(args);

  const inputWindow = effectiveInputWindowTokens({
    contextWindowTokens: args.contextWindowTokens,
    outputReserveTokens: args.outputReserveTokens,
  });

  const threshold = Math.floor(inputWindow * CHAT_SYNC_COMPACTION_RATIO);

  return {
    ...estimate,
    effectiveInputWindowTokens: inputWindow,
    synchronousCompactionThresholdTokens: threshold,
    requiresSynchronousCompaction: estimate.inputTokens > threshold,
  };
}

interface NormalizedTranscript {
  messages: JsonValue;
  hydratedImages: number;
}

type TranscriptPart = Exclude<TranscriptMessage["content"], string>[number];

/** The stored view and the SDK view both work: only the JSON text and the inlined images count. */
function normalizeTranscript(messages: readonly TranscriptMessage[]): NormalizedTranscript {
  let hydratedImages = 0;

  const redact = (part: TranscriptPart) => {
    if (!isHydratedFilePart(part)) return part;
    hydratedImages += 1;

    return { type: "file", mediaType: part.mediaType, data: "[hydrated-image]" };
  };

  const redacted = messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return { ...message, content: message.content.map(redact) };
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      return { ...message, content: message.content.map(redact) };
    }

    return message;
  });

  return { messages: parseJsonText(JSON.stringify(redacted)), hydratedImages };
}

/** A file part whose bytes the chat turn inlined as base64 text. */
function isHydratedFilePart(part: TranscriptPart): part is FilePart & { data: string } {
  return part.type === "file" && typeof part.data === "string";
}

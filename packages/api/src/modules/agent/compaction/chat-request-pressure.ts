import { asSchema, type ModelMessage, type ToolSet } from "ai";

import { effectiveInputWindowTokens } from "@alfred/ai";

import { estimateSerializedTokens } from "./tokens";

/** Synchronous chat compaction is the safety backstop, not the normal trigger. */
export const CHAT_SYNC_COMPACTION_RATIO = 0.85;

/**
 * Provider image accounting is dimension-dependent and unavailable after the
 * SDK content part has been hydrated to base64. Use a conservative fixed
 * allowance instead of treating base64 transport bytes as text tokens, which
 * would over-count a normal image by orders of magnitude.
 */
export const CHAT_HYDRATED_IMAGE_TOKENS = 2_000;

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
  transcript: readonly ModelMessage[];
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
  transcript: readonly ModelMessage[];
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

function normalizeTranscript(messages: readonly ModelMessage[]): {
  messages: unknown[];
  hydratedImages: number;
} {
  let hydratedImages = 0;
  const normalized = JSON.parse(
    JSON.stringify(messages, (_key, value: unknown) => {
      if (!isHydratedFilePart(value)) return value;
      hydratedImages += 1;
      return { type: "file", mediaType: value.mediaType, data: "[hydrated-image]" };
    }),
  ) as unknown[];
  return { messages: normalized, hydratedImages };
}

function isHydratedFilePart(value: unknown): value is {
  type: "file";
  data: string;
  mediaType?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "file" &&
    "data" in value &&
    typeof value.data === "string"
  );
}

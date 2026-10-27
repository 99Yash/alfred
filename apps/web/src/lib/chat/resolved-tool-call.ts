import {
  isToolName,
  jsonObjectSchema,
  parseJsonWith,
  type JsonObject,
  type ToolName,
} from "@alfred/contracts";

/**
 * A chat tool call as it reaches the web: a live `chat.tool` event folded with the ones before it,
 * or a synced `chat_messages.toolCalls` row. Structural, so both producers satisfy it as they are.
 */
export interface RawToolCall {
  toolCallId: string;
  /** Raw name. A retired name must still draw a row, so the sync schema keeps it a string. */
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /** `preview()` pruned the preview. It still parses, so check this before trusting its shape. */
  resultTruncated?: boolean | undefined;
  /** ADR-0070: non-text bytes were stripped before storage. */
  sanitized?: boolean | undefined;
  /** The narration segment this call follows. */
  segmentIndex: number;
}

/**
 * One chat tool call with its previews parsed one time. Every card surface reads this shape.
 * Build it only through {@link resolveToolCall}, at the stream fold or the persisted split.
 */
export interface ResolvedToolCall extends Omit<RawToolCall, "argsPreview"> {
  /** `toolName` when this build registers it. The one registry check on a card's name. */
  registeredName: ToolName | undefined;
  /** `argsPreview` as a JSON object. `undefined` when absent or not an object. */
  args: JsonObject | undefined;
  /** `resultPreview` as a JSON object. The raw text stays only for the JSON dump and a failure line. */
  result: JsonObject | undefined;
}

/** The only place a chat card's previews are parsed and its name is checked against the registry. */
export function resolveToolCall(raw: RawToolCall): ResolvedToolCall {
  return {
    toolCallId: raw.toolCallId,
    toolName: raw.toolName,
    registeredName: isToolName(raw.toolName) ? raw.toolName : undefined,
    status: raw.status,
    args: parseJsonWith(raw.argsPreview, jsonObjectSchema) ?? undefined,
    result: parseJsonWith(raw.resultPreview, jsonObjectSchema) ?? undefined,
    resultPreview: raw.resultPreview,
    resultTruncated: raw.resultTruncated,
    sanitized: raw.sanitized,
    segmentIndex: raw.segmentIndex,
  };
}

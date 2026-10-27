import {
  isToolName,
  jsonObjectSchema,
  parseJsonWith,
  type JsonObject,
  type ToolName,
} from "@alfred/contracts";
import type { EventPayload } from "@alfred/contracts/events";

/**
 * A chat tool call as it reaches the web: a live `chat.tool` event folded with the ones before it,
 * or a synced `chat_messages.toolCalls` row. A `Pick` off the `chat.tool` payload, so the field
 * types cannot drift from the event. The synced row satisfies the same pick (its `status` is the
 * narrower `"succeeded" | "failed"`); the stream fold builds it field by field.
 */
export type RawToolCall = Pick<
  EventPayload<"chat.tool">,
  | "toolCallId"
  | "toolName"
  | "status"
  | "argsPreview"
  | "resultPreview"
  | "resultTruncated"
  | "sanitized"
  | "segmentIndex"
>;

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
  // The spread carries every raw field, so a field added to `RawToolCall` reaches the
  // resolved shape. A new required field fails the build at each producer that does not set it;
  // a new optional field compiles, so the stream fold must be updated by hand.
  const { argsPreview, ...rest } = raw;

  return {
    ...rest,
    registeredName: isToolName(raw.toolName) ? raw.toolName : undefined,
    args: parseJsonWith(argsPreview, jsonObjectSchema) ?? undefined,
    result: parseJsonWith(raw.resultPreview, jsonObjectSchema) ?? undefined,
  };
}

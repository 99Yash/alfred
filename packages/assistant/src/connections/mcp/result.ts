import { safeJsonParse } from "@alfred/contracts";
import type { z } from "zod";
import type { McpProtocolCallResult } from "./protocol";

/**
 * Parse one MCP tool result. `structuredContent` always wins, even if malformed.
 * Without it, the result must be exactly one `text` block. Never blend the two.
 */
export function parseMcpToolResult<Schema extends z.ZodType>(
  result: McpProtocolCallResult,
  schema: Schema,
): z.infer<Schema> | null {
  const structured = result.structuredContent;
  const block = result.content.length === 1 ? result.content[0] : undefined;
  const text = block?.type === "text" ? block.text : undefined;

  const payload =
    structured !== undefined ? structured : text === undefined ? undefined : safeJsonParse(text);

  const parsed = schema.safeParse(payload);

  return parsed.success ? parsed.data : null;
}

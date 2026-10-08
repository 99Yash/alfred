import { getPath, getStringPath, safeJsonParse } from "@alfred/contracts";
import type { z } from "zod";

/**
 * Parse one MCP tool result. `structuredContent` always wins, even if malformed.
 * Without it, the result must be exactly one `text` block. Never blend the two.
 */
export function parseMcpToolResult<Schema extends z.ZodType>(
  result: unknown,
  schema: Schema,
): z.infer<Schema> | null {
  const structured = getPath(result, "structuredContent");
  const content = getPath(result, "content");
  const [block] = Array.isArray(content) && content.length === 1 ? content : [];
  const text = getStringPath(block, "type") === "text" ? getStringPath(block, "text") : undefined;

  const payload =
    structured !== undefined ? structured : text === undefined ? undefined : safeJsonParse(text);

  const parsed = schema.safeParse(payload);

  return parsed.success ? parsed.data : null;
}

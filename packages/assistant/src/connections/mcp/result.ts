import { getPath, getStringPath, safeJsonParse } from "@alfred/contracts";
import type { z } from "zod";

/**
 * Parse one MCP tool result at the transport boundary.
 *
 * `structuredContent` wins whenever the server sent it, even if that value is
 * malformed. Only a result with NO structured payload may use the fallback text
 * block, and that fallback must be exactly one `text` block. This prevents two
 * representations of the same read from being blended when one disagrees with
 * the approved mapping.
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

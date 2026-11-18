/**
 * The binary check of an executed `mcp.call` result (`brokerResult` in `./mcp`), for a script
 * read (ADR-0124 amendment 2026-11-18). A read declared `structured` that returns bytes fails by
 * name. A separate file, so dispatch can import it without the `mcp.call` tool module.
 */

import type { JsonValue } from "@alfred/contracts";
import { z } from "zod";

/** The content blocks of `McpBrokerToolResult.result`. */
const mcpResultContentSchema = z.object({
  result: z.object({ content: z.array(z.unknown()) }),
});

/** An MCP content block that holds bytes: an image, audio, or an embedded resource with a blob. */
const mcpBinaryBlockSchema = z.union([
  z.object({ type: z.enum(["image", "audio"]) }),
  z.object({ type: z.literal("resource"), resource: z.object({ blob: z.string() }) }),
]);

export function mcpResultHasBinaryContent(value: JsonValue): boolean {
  const parsed = mcpResultContentSchema.safeParse(value);

  if (!parsed.success) return false;

  return parsed.data.result.content.some((block) => mcpBinaryBlockSchema.safeParse(block).success);
}

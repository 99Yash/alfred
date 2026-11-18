/**
 * The binary check of an executed `mcp.call` result (`brokerResult` in `./mcp`), for a script
 * read (ADR-0124 amendment 2026-11-18). The client records the fact before bounds remove blocks,
 * and the staging result keeps it for replay. A separate file avoids importing the tool module.
 */

import type { JsonValue } from "@alfred/contracts";
import { z } from "zod";

/** The client owns this fact; the remote result is nested under `result`. */
const mcpBinaryContentFactSchema = z.object({ hasBinaryContent: z.literal(true) });

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
  if (mcpBinaryContentFactSchema.safeParse(value).success) return true;

  // Older saved results have no raw-response fact. Keep detecting the blocks they retained.
  const parsed = mcpResultContentSchema.safeParse(value);

  if (!parsed.success) return false;

  return parsed.data.result.content.some((block) => mcpBinaryBlockSchema.safeParse(block).success);
}

/**
 * Tool-schema budget estimator (#414, PRD #405, User Story 15).
 *
 * Lazy loading is only useful when it shrinks the model-visible payload. This
 * deterministic proxy mirrors the provider envelope but is not a byte-exact
 * provider count; it exists to detect regressions in the same direction and at
 * about the same scale as the real payload.
 */

import { APPROXIMATE_CHARS_PER_TOKEN } from "@alfred/ai";
import { z } from "zod";

import type { RegisteredTool } from "@alfred/assistant/tool-runtime";

export interface ToolSchemaSize {
  bytes: number;
  tokens: number;
}

export interface ToolSurfaceBudget {
  toolCount: number;
  schemaBytes: number;
  schemaTokens: number;
}

export type ToolSchemaDefinition = Pick<RegisteredTool, "name" | "description" | "inputSchema">;

// Registered definitions are write-once after boot. The definition, not its
// schema, owns the cache entry because name and description also affect size.
const schemaSizeCache = new WeakMap<ToolSchemaDefinition, ToolSchemaSize>();

/**
 * Estimate one model-visible tool envelope. Schema conversion failure keeps the
 * name-and-description estimate instead of failing telemetry; the boot-time
 * object-schema guard should make this a defence-in-depth path only.
 */
export function toolSchemaSize(tool: ToolSchemaDefinition): ToolSchemaSize {
  const cached = schemaSizeCache.get(tool);
  if (cached) return cached;

  let inputSchema: unknown;
  try {
    inputSchema = z.toJSONSchema(tool.inputSchema, { io: "input" });
  } catch {
    inputSchema = undefined;
  }
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema,
  });
  const size: ToolSchemaSize = {
    bytes: new TextEncoder().encode(serialized).byteLength,
    tokens: Math.ceil(serialized.length / APPROXIMATE_CHARS_PER_TOKEN),
  };
  schemaSizeCache.set(tool, size);
  return size;
}

export function estimateToolSurfaceBudget(
  definitions: readonly RegisteredTool[],
): ToolSurfaceBudget {
  let schemaBytes = 0;
  let schemaTokens = 0;
  for (const definition of definitions) {
    const size = toolSchemaSize(definition);
    schemaBytes += size.bytes;
    schemaTokens += size.tokens;
  }
  return {
    toolCount: definitions.length,
    schemaBytes,
    schemaTokens,
  };
}

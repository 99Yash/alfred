/** Deterministic estimate of the model-visible tool schema payload. */

import { APPROXIMATE_CHARS_PER_TOKEN } from "@alfred/ai";
import { z } from "zod";

import type { RegisteredTool } from "./registry";

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

const schemaSizeCache = new WeakMap<ToolSchemaDefinition, ToolSchemaSize>();

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

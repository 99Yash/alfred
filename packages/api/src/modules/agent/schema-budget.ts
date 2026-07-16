/**
 * Tool-schema budget estimator (#414, PRD #405, User Story 15).
 *
 * Lazy loading is only worth its round-trip if it actually shrinks the tool
 * payload the model sees. This estimates the serialized JSON-schema size of a
 * tool surface so the `runtime.tool_surface` span can record it and a budget
 * test can fail on a regression (a giant schema slipping into the kernel, or an
 * integration doubling its surface).
 *
 * The estimate mirrors the shape the provider actually sends per tool —
 * `{ name, description, inputSchema }` — using `z.toJSONSchema(..., { io:
 * "input" })`, the same synchronous converter the dispatcher's
 * `acceptedParamNames` already trusts. It is a deterministic proxy, not a
 * byte-exact provider count: what matters for a regression guard is that the
 * number moves the same direction and roughly the same amount as the real
 * payload. Per-tool results are memoized on the registered definition, so tools
 * that intentionally share one input schema still account for their distinct
 * names and descriptions. A per-turn surface estimate is therefore effectively
 * free after the first call.
 */

import { z } from "zod";

import { CHARS_PER_TOKEN } from "./compaction/tokens";
import type { RegisteredTool } from "../tools/registry";

/** Serialized size of one tool's model-visible schema. */
export interface ToolSchemaSize {
  bytes: number;
  tokens: number;
}

/** Aggregate schema budget of a tool surface. */
export interface ToolSurfaceBudget {
  toolCount: number;
  schemaBytes: number;
  schemaTokens: number;
}

export type ToolSchemaDefinition = Pick<RegisteredTool, "name" | "description" | "inputSchema">;

// Registered definitions are write-once after boot, so the complete model-
// visible envelope is stable for the process lifetime. The definition, not its
// schema, owns the cache entry: name and description contribute to the size too.
const schemaSizeCache = new WeakMap<ToolSchemaDefinition, ToolSchemaSize>();

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Serialized size of one registered tool as the model receives it. Falls back to
 * the description-only envelope if the schema can't be converted (such a schema
 * would already fail the boot-time object-type guard, so this is defence in
 * depth, not an expected path) so one unrepresentable schema never throws the
 * whole estimate.
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
    tokens: charsToTokens(serialized.length),
  };
  schemaSizeCache.set(tool, size);
  return size;
}

/** Sum the model-visible schema size across a tool surface. */
export function estimateToolSurfaceBudget(tools: readonly RegisteredTool[]): ToolSurfaceBudget {
  let schemaBytes = 0;
  let schemaTokens = 0;
  for (const tool of tools) {
    const size = toolSchemaSize(tool);
    schemaBytes += size.bytes;
    schemaTokens += size.tokens;
  }
  return {
    toolCount: tools.length,
    schemaBytes,
    schemaTokens,
  };
}

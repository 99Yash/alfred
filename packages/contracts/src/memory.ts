import { z } from "zod";
import { jsonObjectSchema } from "./user-model";

/** @deprecated Use `jsonObjectSchema`; retained as a compatibility export for sync/memory callers. */
export const jsonRecordSchema = jsonObjectSchema;

export const memorySourceSchema = z.object({
  kind: z.enum(["document", "chunk", "tool_call", "cold_start", "user", "agent"]),
  id: z.string().optional(),
  meta: jsonRecordSchema.optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

/**
 * Parse a persisted provenance value, falling back to `fallback` when the
 * stored jsonb does not match `memorySourceSchema`. The `source` column is
 * `unknown` until validated here — every reader of a stored `MemorySource`
 * goes through this one door (ADR-0019 provenance discipline). `context`
 * names the row for the warning so a malformed value is traceable.
 */
export function parseMemorySourceOrDefault(
  value: unknown,
  fallback: MemorySource,
  context: string,
): MemorySource {
  const parsed = memorySourceSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn(
    `[memory] using fallback source for ${context}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
  );
  return fallback;
}

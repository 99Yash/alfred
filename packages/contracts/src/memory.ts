import { z } from "zod";
import { jsonObjectSchema } from "./user-model";

/** @deprecated Use `jsonObjectSchema`. */
export const jsonRecordSchema = jsonObjectSchema;

export const memorySourceSchema = z.object({
  kind: z.enum(["document", "chunk", "tool_call", "cold_start", "user", "agent"]),
  id: z.string().optional(),
  meta: jsonRecordSchema.optional(),
});

export type MemorySource = z.infer<typeof memorySourceSchema>;

/**
 * Parse a stored `MemorySource`, or return `fallback` if it is malformed (ADR-0019).
 * `context` names the row in the warning.
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

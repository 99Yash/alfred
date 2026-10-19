import { memorySourceSchema, type MemorySource } from "@alfred/contracts";
import { logger } from "@alfred/logging";

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
  logger.warn(
    { context, issues: parsed.error.issues.map((i) => i.message) },
    "[memory] using fallback source",
  );

  return fallback;
}

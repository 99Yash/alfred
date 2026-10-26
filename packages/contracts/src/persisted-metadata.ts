import type { z } from "zod";
import { isRecord } from "./guards";

/**
 * Marks a value that came out of a metadata parser. `documents.metadata` is typed for writers,
 * and a loose write shape accepts any object, so without the brand a raw row would type-check
 * where a parsed one is required.
 */
export const PARSED_DOCUMENT_METADATA = "ParsedDocumentMetadata";

/**
 * The one lenient read of a metadata arm: a key whose value fails its own field schema is
 * dropped, so a bad field reads as absent and the rest of the row survives.
 */
export function parsePersistedMetadata<
  Schema extends z.ZodType<unknown> & { shape: Readonly<Record<string, z.ZodType<unknown>>> },
>(schema: Schema, raw: unknown): z.output<Schema> {
  const candidate = isRecord(raw) ? { ...raw } : {};

  for (const [key, field] of Object.entries(schema.shape)) {
    if (key in candidate && !field.safeParse(candidate[key]).success) delete candidate[key];
  }

  return schema.parse(candidate);
}

import type { z } from "zod";
import { isRecord } from "./guards";

/**
 * The one lenient read of a metadata arm: a key whose value fails its own field schema is
 * dropped, so a bad field reads as absent and the rest of the row survives. The arm schema
 * carries its own brand (one literal per arm, named by no call site), so the output stays
 * distinct per arm through this generic function.
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

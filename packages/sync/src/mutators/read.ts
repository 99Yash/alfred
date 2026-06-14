import type { WriteTransaction } from "replicache";
import type { z } from "zod";

export function parseSyncedValue<TSchema extends z.ZodTypeAny>(
  value: unknown,
  schema: TSchema,
): z.output<TSchema> | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export async function readSyncedValue<TSchema extends z.ZodTypeAny>(
  tx: Pick<WriteTransaction, "get">,
  key: string,
  schema: TSchema,
): Promise<z.output<TSchema> | null> {
  const value = await tx.get(key);
  return value === undefined ? null : parseSyncedValue(value, schema);
}

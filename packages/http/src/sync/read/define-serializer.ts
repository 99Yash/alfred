import { isRecord } from "@alfred/contracts";
import { z } from "zod";

/**
 * Generic row -> synced-entity serializer.
 *
 * Define once, configure per schema. Most entities need no mapper at all:
 *   const serializeArtifact = defineSerializer(syncedArtifactSchema);
 *
 * For the few with real logic (status gates, revision overlay, discriminated
 * unions) pass a small mapper that returns Dates directly — stringifyDates
 * walks the result and turns every Date into an ISO string:
 *   defineSerializer(schema, (row) => ({ ...row, source: parse(row.source) }))
 *
 * Throw `SerializationError` or let the schema throw `ZodError` to skip the
 * row — `toEntityRow` treats both as recoverable per entity-row.ts.
 */
export function defineSerializer<Row, Output>(
  schema: z.ZodType<Output>,
  map: (row: Row) => unknown = (row) => row,
): (row: Row) => Output {
  return (row) => schema.parse(stringifyDates(map(row)));
}

/** `T` with every `Date` (at any depth) replaced by its ISO string. */
export type DatesAsIso<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? DatesAsIso<U>[]
    : T extends object
      ? { [K in keyof T]: DatesAsIso<T[K]> }
      : T;

function stringifyDates<T>(value: T): DatesAsIso<T> {
  // TypeScript cannot relate a conditional type to the branch that produced
  // it, so each return below asserts the shape `DatesAsIso<T>` describes for
  // that runtime case.
  if (value instanceof Date) {
    // SAFETY: T is Date here, and DatesAsIso<Date> is string.
    return value.toISOString() as DatesAsIso<T>;
  }
  if (Array.isArray(value)) {
    // SAFETY: T is an array here, and DatesAsIso maps over its element type.
    return value.map(stringifyDates) as DatesAsIso<T>;
  }
  if (isRecord(value)) {
    const out: Record<string, DatesAsIso<unknown>> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stringifyDates(v);
    }
    // SAFETY: T is an object here; `out` holds every key of `value` with its
    // value walked, which is what DatesAsIso<T> describes for the object case.
    return out as DatesAsIso<T>;
  }
  // SAFETY: a primitive is unchanged, and DatesAsIso<T> is T for primitives.
  return value as DatesAsIso<T>;
}

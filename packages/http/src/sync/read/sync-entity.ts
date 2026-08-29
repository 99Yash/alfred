import { isRecord } from "@alfred/contracts";
import { SYNC_MODEL, type IDBKeys } from "@alfred/sync";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { SerializationError } from "./entity-row";

/**
 * Generic Replicache pull fetcher factory.
 *
 * Each domain owner supplies `query` (the raw rows, already within the sync
 * window) and `map` (row → the shape its zod schema wants, Dates included).
 * `syncEntity` derives everything else from the registry:
 *
 *   - the IDB id and `rowVersion` come from the entity's own fields via
 *     `SYNC_MODEL[slug].key`, so the server's CVR key can never disagree with
 *     the client's key (one source of truth, `@alfred/sync`).
 *   - serialization runs the owning zod schema's `parse` after coercing Dates
 *     to ISO strings.
 *
 * Every throwing step (the domain `map`, the schema `parse`) runs inside
 * `toEntityRow`'s recoverable boundary — throw `SerializationError` or let zod
 * throw to skip that row instead of failing the pull (see `entity-row.ts`).
 */
export function syncEntity<Slug extends IDBKeys, Row>(
  slug: Slug,
  config: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (tx: any, userId: string) => Promise<Row[]>;
    map: (row: Row) => unknown;
  },
): EntityFetcher {
  const model = SYNC_MODEL[slug];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (tx: any, userId: string) => {
    const rows = await config.query(tx, userId);
    return rows.flatMap((row) =>
      toEntityRow({
        slug,
        make: () => {
          const mapped = config.map(row);
          if (!isRecord(mapped)) {
            throw new SerializationError(`${slug} row is not an object`);
          }
          const serialized = model.schema.parse(stringifyDates(mapped));
          return {
            // The registry `key` derives the id from the entity's own field,
            // so the CVR key uses the same "which field is the id" rule as the
            // client mutators.
            //
            // SAFETY: `slug` selects the exact `key` for `schema` at runtime,
            // but TypeScript sees `model` as a union of models, so the parity
            // between `serialized` (that schema's output) and `key` (that
            // schema's key) cannot be proven structurally. The cast is sound:
            // both halves are pinned by the same `slug` literal.
            id: model.key(serialized as never),
            rowVersion: serialized.rowVersion,
            serialized,
          };
        },
      }),
    );
  };
}

/**
 * `T` with every `Date` (at any depth) replaced by its ISO string.
 */
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

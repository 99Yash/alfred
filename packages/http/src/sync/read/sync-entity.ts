import { isRecord } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import { parseSyncPullValue, type IDBKeys, type SyncModelFor } from "@alfred/sync";
import type { z } from "zod";
import { toEntityRow, type EntityFetcher } from "./entity-row";

/** `T` with every `Date` at any depth replaced by its ISO-string output. */
export type DatesAsIso<T> = T extends Date
  ? string
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends readonly (infer U)[]
      ? DatesAsIso<U>[]
      : T extends object
        ? { [K in keyof T]: DatesAsIso<T[K]> }
        : T;

type MapperMatchesSchema<Slug extends IDBKeys, Mapped> =
  DatesAsIso<Mapped> extends z.input<SyncModelFor<Slug>["schema"]>
    ? unknown
    : {
        readonly "syncEntity map output must match the selected schema after Date serialization": never;
      };

type SyncEntityConfig<Slug extends IDBKeys, Row, Mapped> = {
  query: (tx: DbTransaction, userId: string) => Promise<Row[]>;
  map: (row: Row) => Mapped & MapperMatchesSchema<Slug, Mapped>;
  /** Raw-row identity for the skip warning, available before serialization runs. */
  idOf: (row: Row) => string;
};

/**
 * Define one Replicache pull reader.
 *
 * The domain supplies the query and its real projection. This module owns the
 * mechanical work: recursive Date serialization, wire-schema parsing, ID/CVR
 * derivation, and one-bad-row isolation. The mapper's post-serialization type
 * must satisfy the selected model schema, so a missing or renamed field fails
 * TypeScript instead of turning into a silently skipped row at runtime.
 */
export function syncEntity<Slug extends IDBKeys, Row, Mapped>(
  slug: Slug,
  config: SyncEntityConfig<Slug, Row, Mapped>,
): EntityFetcher<Slug> {
  return async (tx, userId) => {
    const rows = await config.query(tx, userId);
    return rows.flatMap((row) =>
      toEntityRow({
        slug,
        id: config.idOf(row),
        make: () => {
          const mapped = config.map(row);
          const { id, rowVersion, value } = parseSyncPullValue(slug, stringifyDates(mapped));
          return { id, rowVersion, serialized: value };
        },
      }),
    );
  };
}

function stringifyDates<T>(value: T): DatesAsIso<T> {
  if (value instanceof Date) {
    // SAFETY: the Date branch is serialized to the string that DatesAsIso<Date> describes.
    return value.toISOString() as DatesAsIso<T>;
  }
  if (Array.isArray(value)) {
    // SAFETY: DatesAsIso maps an array to the recursively serialized element type.
    return value.map(stringifyDates) as DatesAsIso<T>;
  }
  if (isRecord(value)) {
    const out: Record<string, DatesAsIso<unknown>> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = stringifyDates(entry);
    }
    // SAFETY: isRecord proves a plain object; every own entry is copied and serialized.
    return out as DatesAsIso<T>;
  }
  // SAFETY: primitives and non-plain values contain no traversable Date for this wire seam.
  return value as DatesAsIso<T>;
}

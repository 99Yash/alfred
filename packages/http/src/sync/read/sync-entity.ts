import { isRecord } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import { parseSyncPullValue, type IDBKeys, type SyncModelFor } from "@alfred/sync";
import type { z } from "zod";
import { toEntityRow, type EntityFetcher } from "./entity-row";

type MapperHasSchemaKeys<Slug extends IDBKeys, Mapped> =
  Exclude<keyof z.input<SyncModelFor<Slug>["schema"]>, keyof Mapped> extends never
    ? unknown
    : {
        readonly "syncEntity map output is missing a selected schema field": never;
      };

type SyncEntityConfig<Slug extends IDBKeys, Row, Mapped> = {
  query: (tx: DbTransaction, userId: string) => Promise<Row[]>;
  map: (row: Row) => Mapped & MapperHasSchemaKeys<Slug, Mapped>;
};

/**
 * Define one Replicache pull reader.
 *
 * The domain supplies the query and its real projection. This module owns the
 * mechanical work: recursive Date serialization, wire-schema parsing, ID/CVR
 * derivation, and one-bad-row isolation. The mapper must supply every selected
 * schema field, while the selected schema validates field values at runtime.
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
        make: () => {
          const mapped = config.map(row);
          const { id, rowVersion, value } = parseSyncPullValue(slug, stringifyDates(mapped));
          return { id, rowVersion, serialized: value };
        },
      }),
    );
  };
}

// eslint-disable-next-line anti-slop/no-unknown-returns -- the selected sync schema owns the output contract and parses this value immediately
function stringifyDates(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(stringifyDates);
  }
  if (isRecord(value)) {
    const out = Object.assign({}, value);
    for (const [key, entry] of Object.entries(value)) {
      out[key] = stringifyDates(entry);
    }
    // eslint-disable-next-line anti-slop/no-known-value-widening -- the selected sync schema validates this complete projection immediately
    return out;
  }
  return value;
}

import { isRecord } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import type { IDBKeys, SyncModelFor } from "@alfred/sync";
import { ZodError, type z } from "zod";
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

type SyncEntityModelContract<Slug extends IDBKeys> = Pick<
  SyncModelFor<Slug>,
  "slug" | "schema" | "parsePullValue"
>;

/**
 * Define one Replicache pull reader.
 *
 * The domain supplies the query and its real projection. This module owns the
 * mechanical work: recursive Date serialization, wire-schema parsing, ID/CVR
 * derivation, and one-bad-row isolation. The mapper must supply every selected
 * schema field, while the selected schema validates field values at runtime.
 */
export function syncEntity<const Model extends SyncEntityModelContract<IDBKeys>, Row, Mapped>(
  model: Model,
  config: SyncEntityConfig<Model["slug"], Row, Mapped>,
): EntityFetcher<Model["slug"]> {
  return async (tx, userId) => {
    const rows = await config.query(tx, userId);
    return rows.flatMap((row) =>
      toEntityRow({
        slug: model.slug,
        make: () => {
          const mapped = config.map(row);
          try {
            const { id, storageKey, rowVersion, value } = model.parsePullValue(
              stringifyDates(mapped),
            );
            return { id, storageKey, rowVersion, serialized: value };
          } catch (err) {
            if (err instanceof ZodError) {
              const paths = err.issues
                .map((issue) =>
                  issue.path.length > 0
                    ? issue.path.map((segment) => String(segment)).join(".")
                    : "<root>",
                )
                .join(", ");
              let preview = "<unserializable mapped value>";
              try {
                const serialized = JSON.stringify(mapped);
                if (serialized !== undefined) preview = serialized.slice(0, 200);
              } catch {
                // The schema error remains recoverable even when its diagnostic cannot serialize the value.
              }
              console.warn(
                `[replicache] invalid ${model.slug} row at ${paths}; mapped value: ${preview}`,
              );
            }
            throw err;
          }
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

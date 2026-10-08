import { isRecord, toMessage } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import type { IDBKeys, SyncModelFor } from "@alfred/sync";
import { ZodError, type z } from "zod";
import {
  isRecoverableSerializationError,
  toEntityRow,
  type EntityFetcher,
  type EntityVersion,
  type VersionInputFor,
} from "./entity-row";

type MapperHasSchemaKeys<Slug extends IDBKeys, Mapped> =
  Exclude<keyof z.input<SyncModelFor<Slug>["schema"]>, keyof Mapped> extends never
    ? unknown
    : {
        readonly "syncEntity map output is missing a selected schema field": never;
      };

type SyncEntityConfig<Slug extends IDBKeys, Version, Row, Mapped> = {
  /** Identity plus `rowVersion` for every visible row. This decides which ids the CVR holds. */
  versionQuery: (tx: DbTransaction, userId: string, readAt: Date) => Promise<Version[]>;
  /** Full values for the changed rows only. */
  loadQuery: (
    tx: DbTransaction,
    userId: string,
    changedVersions: readonly Version[],
    readAt: Date,
  ) => Promise<Row[]>;
  map: (row: Row) => Mapped & MapperHasSchemaKeys<Slug, Mapped>;
};

type SyncEntityModelContract<Slug extends IDBKeys> = Pick<
  SyncModelFor<Slug>,
  "slug" | "schema" | "parsePullValue" | "parsePullVersion"
>;

/**
 * Define one Replicache pull reader from a version query and a load query.
 * Unchanged versions are acknowledged without a read. A changed row that fails to
 * load, map or parse is in neither list, so the next pull retries it.
 */
export function syncEntity<
  const Model extends SyncEntityModelContract<IDBKeys>,
  Version extends VersionInputFor<Model["slug"]>,
  Row,
  Mapped,
>(
  model: Model,
  config: SyncEntityConfig<Model["slug"], Version, Row, Mapped>,
): EntityFetcher<Model["slug"]> {
  return async (tx, userId, previous) => {
    const readAt = new Date();
    const unchanged: EntityVersion[] = [];
    const changedVersions: Version[] = [];

    for (const projection of await config.versionQuery(tx, userId, readAt)) {
      const version = toPullVersion(model, projection);

      if (!version) continue;

      if (previous[version.id]?.v === version.rowVersion) unchanged.push(version);
      else changedVersions.push(projection);
    }

    if (changedVersions.length === 0) return { unchanged, rows: [] };

    const rows = await config.loadQuery(tx, userId, changedVersions, readAt);

    return {
      unchanged,
      rows: rows.flatMap((row) =>
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
                  // Keep the placeholder preview.
                }

                console.warn(
                  `[replicache] invalid ${model.slug} row at ${paths}; mapped value: ${preview}`,
                );
              }

              throw err;
            }
          },
        }),
      ),
    };
  };
}

/** A malformed version skips one row, not the pull. With no CVR entry, it is retried. */
function toPullVersion<Model extends SyncEntityModelContract<IDBKeys>>(
  model: Model,
  projection: unknown,
): EntityVersion | null {
  try {
    return model.parsePullVersion(projection);
  } catch (err) {
    if (!isRecoverableSerializationError(err)) throw err;
    console.warn(`[replicache] skipping invalid ${model.slug} version row: ${toMessage(err)}`);

    return null;
  }
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

    return out;
  }

  return value;
}

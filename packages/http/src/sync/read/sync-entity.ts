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
  /**
   * The visible set, projected down to identity plus `rowVersion`, over the same
   * membership `loadQuery` uses: this is what decides which ids the CVR
   * describes. The narrow `Version` constraint is what the model parser needs,
   * not what the statement may select, so a reader whose membership is decided
   * in JS adds the few columns that test reads.
   */
  versionQuery: (tx: DbTransaction, userId: string, readAt: Date) => Promise<Version[]>;
  /**
   * Full values for the changed projections only. Membership stays the version
   * query's; this only narrows which of those rows are read.
   */
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
 * Define one Replicache pull reader.
 *
 * The domain supplies two queries over one authored membership — a light
 * version projection and a full load restricted to the changed rows — plus its
 * real projection. This module owns the mechanical work: diffing versions
 * against the previous CVR, recursive Date serialization, wire-schema parsing,
 * ID/CVR derivation, and one-bad-row isolation. The mapper must supply every
 * selected schema field, while the selected schema validates field values at
 * runtime.
 *
 * TWO SEPARATE OUTCOMES, AND THAT IS THE POINT. An unchanged version is
 * membership the client already holds, acknowledged without reading a value. A
 * changed version has no acknowledged value yet, so it must load and pass the
 * wire schema before this reader reports a row for it. Only the second kind may
 * be cached as client state; the first already was. A changed row that fails to
 * load, to map, or to parse lands in neither list, which leaves it unversioned
 * so the next pull tries it again.
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
      ),
    };
  };
}

/**
 * THE VERSION HALF OF THE RECOVERABLE PATH. A projection that is not a
 * well-formed identity plus a `rowVersion` is one skipped row, not a failed
 * pull — the same rule `toEntityRow` applies to a full value, and it shares that
 * predicate rather than sniffing messages. It gets no CVR entry, so an id the
 * previous snapshot holds is dropped by `pull.ts`'s delete loop and retried.
 */
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

import type { IDBKeys, SyncedEntity } from "@alfred/sync";
import { toEntityRow, type EntityFetcher } from "./entity-row";

/**
 * Generic fetcher factory for Replicache pull.
 *
 * Each domain still owns its serialize function and its query shape.
 * The factory lifts only the shared `flatMap -> toEntityRow` loop so a bad
 * row remains a skipped row and rowVersion stays uniform.
 *
 * `query` returns the raw rows (already filtered for sync window).
 * `idOf` and `versionOf` derive the CVR keys so composite ids
 * (briefing `${date}/${slot}`, pref `key`) stay explicit per domain.
 * `serialize` must call the owning zod schema's `parse`; throw
 * `SerializationError` or let zod throw to skip the row.
 */
export function defineFetcher<Row>(config: {
  slug: IDBKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (tx: any, userId: string) => Promise<Row[]>;
  idOf: (row: Row) => string;
  versionOf: (row: Row) => number;
  serialize: (row: Row) => SyncedEntity;
}): EntityFetcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (tx: any, userId: string) => {
    const rows = await config.query(tx, userId);
    return rows.flatMap((row) =>
      toEntityRow({
        slug: config.slug,
        id: config.idOf(row),
        rowVersion: config.versionOf(row),
        serialize: () => config.serialize(row),
      }),
    );
  };
}

import { toMessage } from "@alfred/contracts";
import type { DbTransaction } from "@alfred/db";
import type { IDBKeys, SyncedValueFor, SyncModelFor } from "@alfred/sync";
import { ZodError } from "zod";
import type { ClientViewMap } from "../cvr";

/** `id` and `rowVersion` drive the CVR diff; `storageKey` and `serialized` go to Replicache. */
export interface EntityRow<Slug extends IDBKeys = IDBKeys> {
  id: string;
  storageKey: `${Slug}/${string}`;
  rowVersion: number;
  serialized: SyncedValueFor<Slug>;
}

/** Identity plus version only, with no claim about values. */
export type EntityVersion = ReturnType<SyncModelFor<IDBKeys>["parsePullVersion"]>;

export type VersionInputFor<Slug extends IDBKeys> = Parameters<
  SyncModelFor<Slug>["storageKeyForId"]
>[0] & { rowVersion: number };

/** A changed row that fails to load or parse is in neither list, so the next pull retries it. */
export type EntityReadResult<Slug extends IDBKeys> = {
  unchanged: EntityVersion[];
  rows: EntityRow<Slug>[];
};

export type EntityFetcher<Slug extends IDBKeys> = (
  tx: DbTransaction,
  userId: string,
  previous: Readonly<ClientViewMap>,
) => Promise<EntityReadResult<Slug>>;

/**
 * One bad row must cost one row, never the whole pull. A plain `Error` instead of a
 * {@link SerializationError} turns a skipped row into a sync outage, and types stay green.
 * Keep every throwing step inside `make`.
 */
export function toEntityRow<Slug extends IDBKeys>(args: {
  slug: Slug;
  make: () => EntityRow<Slug>;
}): EntityRow<Slug>[] {
  try {
    return [args.make()];
  } catch (err) {
    if (!isRecoverableSerializationError(err)) throw err;
    console.warn(`[replicache] skipping invalid ${args.slug} row: ${toMessage(err)}`);

    return [];
  }
}

/**
 * A row broke a sync invariant, so skip it. Tagged, so the check is by type, not message.
 * Only `src/sync/read/` may throw it; keep it off the `@alfred/http` barrel.
 */
export class SerializationError extends Error {
  readonly _tag = "SerializationError" as const;
  constructor(message: string) {
    super(message);
    this.name = "SerializationError";
  }
}

export function isRecoverableSerializationError(err: unknown): boolean {
  return err instanceof ZodError || err instanceof SerializationError;
}

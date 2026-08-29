import { toMessage } from "@alfred/contracts";
import type { IDBKeys, SyncedEntity } from "@alfred/sync";
import { ZodError } from "zod";

/**
 * One row's contribution to the patch: its row_version drives CVR diffing,
 * and `serialized` is the value Replicache writes to the client store.
 */
export interface EntityRow {
  id: string;
  rowVersion: number;
  serialized: SyncedEntity;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EntityFetcher = (tx: any, userId: string) => Promise<EntityRow[]>;

/**
 * THE RECOVERABLE-SERIALIZATION PATH. Read this before editing any file in
 * this directory.
 *
 * One malformed row must cost the user one row, never the whole pull. Drop the
 * `try` below, narrow {@link isRecoverableSerializationError}, or let a domain
 * `make` throw a plain `Error` where it used to throw
 * {@link SerializationError}, and a single bad row stops being a skipped row
 * and becomes a failed pull — a total sync outage for that user, with every
 * type check green.
 *
 * `make` produces the whole row contribution — id, rowVersion, and the parsed
 * serialized value — so every derivation that can throw (the domain mapper,
 * the schema `parse`) stays behind the same recoverable boundary. The caller
 * (`syncEntity`, in this directory) keeps only the query.
 *
 * `packages/http/test/replicache/entity-row.test.ts` drives the three arms.
 */
export function toEntityRow(args: { slug: IDBKeys; make: () => EntityRow }): EntityRow[] {
  try {
    return [args.make()];
  } catch (err) {
    if (!isRecoverableSerializationError(err)) throw err;
    // SAFETY: the id is only known after `make` returns, so a skipped row is
    // logged by slug alone — the mapper/schema that failed is still on record.
    console.warn(`[replicache] skipping invalid ${args.slug} row: ${toMessage(err)}`);
    return [];
  }
}

/**
 * A row failed a sync-serialization invariant — a non-null field came back
 * null, or a row in a non-syncable status reached its serializer. Tagged so
 * {@link isRecoverableSerializationError} can skip the row by type rather than
 * sniffing a `[replicache]` message prefix (the same "branch on the tag, not
 * the string" rule the shared `HttpError` follows).
 *
 * EXPORTED, AND THAT IS A REAL INTERFACE COST. This class was private to the
 * single `entities.ts` module before the per-domain split, so "only the pull
 * read model may declare a row skippable" was enforced by the module boundary.
 * Twelve domain files now throw it, so the rule is convention inside
 * `src/sync/read/` rather than encapsulation. It stays off the `@alfred/http`
 * barrel, so the blast radius is this one directory.
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

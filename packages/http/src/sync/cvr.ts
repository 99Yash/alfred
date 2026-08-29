import type { IDBKeys } from "@alfred/sync";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";

/** One entry per row in the CVR snapshot — `v` is the row's `row_version`. */
export interface CVRRow {
  v: number;
}

/** id → CVRRow for one entity. */
export type ClientViewMap = Record<string, CVRRow>;

/**
 * A Client-View Record — what the client had last time they pulled.
 * Diffing the current visible row set against this produces the next patch.
 *
 * `entities` is keyed by each model's persisted raw prefix (for example,
 * `"note"` and `"fact"`) so the pull
 * dispatcher can iterate generically — adding a new synced entity is one
 * line in the `SYNC_MODEL` registry plus one entry in the pull entity table.
 *
 * `clients` tracks `lastMutationId` per client at snapshot time. Pull emits
 * only the diffs so Replicache's invariant holds: if `cookie` doesn't change,
 * `lastMutationIDChanges` must be empty.
 */
export interface CVRSnapshot {
  entities: Partial<Record<IDBKeys, ClientViewMap>>;
  clients?: Record<string, number>;
}

/** CVR snapshots expire after 12 h of inactivity. */
const TTL_SECONDS = 12 * 60 * 60;

export class CVRStore {
  constructor(private readonly redis: BoundedRedis) {}

  private key(clientGroupId: string, version: number): string {
    return `cvr:${clientGroupId}:${version}`;
  }

  async get(clientGroupId: string, version: number): Promise<CVRSnapshot | null> {
    const raw = await this.redis.get(this.key(clientGroupId, version));
    if (!raw) return null;
    try {
      // SAFETY: the only writer is put(), which stringifies a CVRSnapshot;
      // truncated or foreign Redis content throws and degrades to null below.
      return JSON.parse(raw) as CVRSnapshot;
    } catch {
      return null;
    }
  }

  async put(clientGroupId: string, version: number, snapshot: CVRSnapshot): Promise<void> {
    await this.redis.set(
      this.key(clientGroupId, version),
      JSON.stringify(snapshot),
      "EX",
      TTL_SECONDS,
    );
  }
}

let _store: CVRStore | undefined;

export function getCVRStore(): CVRStore {
  if (_store) return _store;
  _store = new CVRStore(createRedisConnection("command"));
  return _store;
}

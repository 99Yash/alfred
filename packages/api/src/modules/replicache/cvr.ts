import type IORedis from "ioredis";
import { createRedisConnection } from "../../queue/connection";

/** One entry per note row in the CVR snapshot. */
export interface CVRRow {
  v: number;
}

/**
 * A Client-View Record — what the client had last time they pulled.
 * Diffing the current visible row set against this produces the next patch.
 *
 * `clients` tracks `lastMutationId` per client at snapshot time. Pull emits
 * only the diffs so Replicache's invariant holds: if `cookie` doesn't change,
 * `lastMutationIDChanges` must be empty.
 */
export interface CVRSnapshot {
  notes: Record<string, CVRRow>;
  clients?: Record<string, number>;
}

/** CVR snapshots expire after 12 h of inactivity. */
const TTL_SECONDS = 12 * 60 * 60;

export class CVRStore {
  constructor(private readonly redis: IORedis) {}

  private key(clientGroupId: string, version: number): string {
    return `cvr:${clientGroupId}:${version}`;
  }

  async get(clientGroupId: string, version: number): Promise<CVRSnapshot | null> {
    const raw = await this.redis.get(this.key(clientGroupId, version));
    if (!raw) return null;
    try {
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
  _store = new CVRStore(createRedisConnection());
  return _store;
}

import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { IDB_KEY_NAMES, type IDBKeys } from "@alfred/sync";
import { z } from "zod";

/** `v` is the row's `row_version`. */
const cvrRowSchema = z.object({ v: z.number().int() });

export type CVRRow = z.infer<typeof cvrRowSchema>;

const clientViewMapSchema = z.record(z.string(), cvrRowSchema);

export type ClientViewMap = z.infer<typeof clientViewMapSchema>;

const IDB_KEY_NAME_SET = new Set<string>(IDB_KEY_NAMES);

const idbKeySchema = z.custom<IDBKeys>((value) => {
  const parsed = z.string().safeParse(value);

  return parsed.success && IDB_KEY_NAME_SET.has(parsed.data);
}, "unknown synced entity slug");

/**
 * What the client held at its last pull. `entities` is keyed by model prefix.
 * Replicache rule: if the cookie does not change, `lastMutationIDChanges` must be empty.
 */
const cvrSnapshotSchema = z.object({
  entities: z.partialRecord(idbKeySchema, clientViewMapSchema),
  clients: z.record(z.string(), z.number().int()).optional(),
});

export type CVRSnapshot = z.infer<typeof cvrSnapshotSchema>;

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
      const input: unknown = JSON.parse(raw);
      const parsed = cvrSnapshotSchema.safeParse(input);

      return parsed.success ? parsed.data : null;
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

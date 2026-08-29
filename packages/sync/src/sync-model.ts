import type { ReadonlyJSONValue, ReadTransaction, WriteTransaction } from "replicache";
import { z } from "zod";
import {
  syncedActionPolicySchema,
  syncedActionStagingSchema,
  syncedArtifactSchema,
  syncedBriefingSchema,
  syncedChatAttachmentSchema,
  syncedChatMessageSchema,
  syncedChatThreadSchema,
  syncedFactSchema,
  syncedNoteSchema,
  syncedPreferenceSchema,
  syncedSkillRevisionSchema,
  syncedSkillRunSchema,
  syncedSkillSchema,
  syncedTodoSchema,
  syncedTriageTagSchema,
  syncedWorkflowSchema,
} from "./schemas";

/**
 * One synced Replicache entity: the prefix of its IDB keys, the zod schema
 * that owns its shape, and the functions that derive full IDB storage keys.
 *
 * This is the single source of truth for "which field of a synced entity is
 * its IDB id". The server pull (`syncEntity` in `@alfred/http`), the client
 * mutators, and the key builders all read from here — so a server that
 * keys triage tags by `id` and a client that keys them by `threadId` can no
 * longer compile.
 *
 * Each registered Zod object schema is also the allowlist for browser-visible
 * fields. Its default unknown-key stripping is intentional: an identity mapper
 * can pass a whole server row, and only schema-declared fields reach the browser.
 * Do not make these schemas strict; a new database-only column must not
 * invalidate and skip the row.
 *
 * `storageKeyFor` derives a full key (`todo/abc`) from a parsed entity;
 * `storageKeyForId` builds one from the model's typed identity; `prefix` is the scan prefix
 * (`todo/`). No public key operation returns a bare id-part, so a caller cannot
 * pass the result of a key builder to Replicache by mistake.
 */
type SyncSchema = z.ZodType<{ rowVersion: number }, unknown>;

export type SyncStringKey<TSchema extends SyncSchema> = {
  [Key in keyof z.output<TSchema>]-?: z.output<TSchema>[Key] extends string ? Key : never;
}[keyof z.output<TSchema>] &
  string;

export type SyncIdentity<
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> = Pick<z.output<TSchema>, TKeys[number]>;

type ProperLeadingKeys<
  TKeys extends readonly PropertyKey[],
  Acc extends readonly PropertyKey[] = [],
> = TKeys extends readonly [
  infer Head extends PropertyKey,
  ...infer Tail extends readonly PropertyKey[],
]
  ? Tail extends readonly []
    ? never
    : readonly [...Acc, Head] | ProperLeadingKeys<Tail, readonly [...Acc, Head]>
  : never;

type IdentityForKeys<TSchema extends SyncSchema, TKeys extends readonly PropertyKey[]> = Pick<
  z.output<TSchema>,
  TKeys[number] & keyof z.output<TSchema>
>;

export type SyncIdentityPrefix<
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> =
  ProperLeadingKeys<TKeys> extends infer PrefixKeys
    ? PrefixKeys extends readonly PropertyKey[]
      ? IdentityForKeys<TSchema, PrefixKeys>
      : never
    : never;

export interface SyncEntityModel<
  Prefix extends string,
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> {
  readonly slug: Prefix;
  readonly prefix: `${Prefix}/`;
  readonly schema: TSchema;
  readonly key: TKeys;
  storageKeyForId(id: SyncIdentity<TSchema, TKeys>): `${Prefix}/${string}`;
  storageKeyFor(entity: z.output<TSchema>): `${Prefix}/${string}`;
  scan(tx: Pick<ReadTransaction, "scan">): Promise<z.output<TSchema>[]>;
  scanPrefix(
    tx: Pick<ReadTransaction, "scan">,
    id: SyncIdentityPrefix<TSchema, TKeys>,
  ): Promise<z.output<TSchema>[]>;
  get(
    tx: Pick<ReadTransaction, "get">,
    id: SyncIdentity<TSchema, TKeys>,
  ): Promise<z.output<TSchema> | null>;
  put(tx: Pick<WriteTransaction, "set">, value: z.input<TSchema>): Promise<void>;
  del(tx: Pick<WriteTransaction, "del">, id: SyncIdentity<TSchema, TKeys>): Promise<void>;
  parsePullValue(input: unknown): {
    id: string;
    storageKey: `${Prefix}/${string}`;
    rowVersion: number;
    value: z.output<TSchema>;
  };
}

function identityPart<TValue extends object>(value: TValue, keys: readonly PropertyKey[]): string {
  return keys
    .map((key) => {
      const part = Reflect.get(value, key);
      if (typeof part !== "string") {
        throw new TypeError(`sync identity field ${String(key)} must be a string`);
      }
      return part;
    })
    .join("/");
}

function leadingIdentityKeys<TValue extends object>(
  value: TValue,
  keys: readonly PropertyKey[],
): PropertyKey[] {
  const provided = keys.filter((key) => Object.hasOwn(value, key));
  const expected = keys.slice(0, provided.length);
  if (
    provided.length === 0 ||
    provided.length === keys.length ||
    provided.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("sync scan identity must be a non-empty proper leading prefix");
  }
  return expected;
}

function model<
  const Prefix extends string,
  TSchema extends SyncSchema,
  const TKeys extends readonly [SyncStringKey<TSchema>, ...SyncStringKey<TSchema>[]],
>(
  prefixRaw: Prefix,
  schema: TSchema,
  identity: { readonly key: TKeys },
): SyncEntityModel<Prefix, TSchema, TKeys> {
  const { key } = identity;
  // SAFETY: Prefix is the literal type of prefixRaw, so appending `/` produces
  // the exact template-literal type declared here.
  const prefix = `${prefixRaw}/` as `${Prefix}/`;
  const storageKeyForId = (id: SyncIdentity<TSchema, TKeys>): `${Prefix}/${string}` => {
    return `${prefix}${identityPart(id, key)}` as `${Prefix}/${string}`;
  };
  return {
    slug: prefixRaw,
    prefix,
    schema,
    key,
    storageKeyForId,
    storageKeyFor: (entity) => storageKeyForId(entity),
    scan: async (tx) => {
      const values = await tx.scan({ prefix }).values().toArray();
      const parsed: z.output<TSchema>[] = [];
      for (const value of values) {
        const result = schema.safeParse(value);
        if (result.success) parsed.push(result.data);
      }
      return parsed;
    },
    scanPrefix: async (tx, id) => {
      const boundedPrefix = `${prefix}${identityPart(id, leadingIdentityKeys(id, key))}/`;
      const values = await tx.scan({ prefix: boundedPrefix }).values().toArray();
      const parsed: z.output<TSchema>[] = [];
      for (const value of values) {
        const result = schema.safeParse(value);
        if (result.success) parsed.push(result.data);
      }
      return parsed;
    },
    get: async (tx, id) => {
      const value = await tx.get(storageKeyForId(id));
      if (value === undefined) return null;
      const result = schema.safeParse(value);
      return result.success ? result.data : null;
    },
    put: async (tx, input) => {
      const value = schema.parse(input);
      await tx.set(storageKeyForId(value), normalizeToReadonlyJSON(value));
    },
    del: async (tx, id) => {
      await tx.del(storageKeyForId(id));
    },
    parsePullValue: (input: unknown) => {
      const value = schema.parse(input);
      const storageKey = storageKeyForId(value);
      return {
        id: identityPart(value, key),
        storageKey,
        rowVersion: value.rowVersion,
        value,
      };
    },
  };
}

/**
 * Single registry of every synced entity.
 *
 * `IDBKeys` and `SyncedEntity` are derived from this map, so
 * adding an entity is one entry here plus one fetcher and one mutator — no
 * parallel schema/key/SyncedEntity-union bookkeeping.
 *
 * The literal order is load-bearing: `IDB_KEY_NAMES` and the server patch
 * dispatcher preserve this insertion order. Keep existing entries stable.
 */
const syncModels = {
  note: model("note", syncedNoteSchema, { key: ["id"] }),
  fact: model("fact", syncedFactSchema, { key: ["id"] }),
  briefing: model("briefing", syncedBriefingSchema, { key: ["briefingDate", "slot"] }),
  pref: model("pref", syncedPreferenceSchema, { key: ["key"] }),
  skill: model("skill", syncedSkillSchema, { key: ["id"] }),
  skillrev: model("skillrev", syncedSkillRevisionSchema, { key: ["id"] }),
  skillrun: model("skillrun", syncedSkillRunSchema, { key: ["id"] }),
  actionstaging: model("actionstaging", syncedActionStagingSchema, { key: ["id"] }),
  actionpolicy: model("actionpolicy", syncedActionPolicySchema, { key: ["userId"] }),
  workflow: model("workflow", syncedWorkflowSchema, { key: ["slug"] }),
  todo: model("todo", syncedTodoSchema, { key: ["id"] }),
  chatthread: model("chatthread", syncedChatThreadSchema, { key: ["id"] }),
  chatmsg: model("chatmsg", syncedChatMessageSchema, { key: ["id"] }),
  chatatt: model("chatatt", syncedChatAttachmentSchema, { key: ["id"] }),
  artifact: model("artifact", syncedArtifactSchema, { key: ["id"] }),
  triagetag: model("triagetag", syncedTriageTagSchema, { key: ["threadId"] }),
};

export const SYNC_MODEL = syncModels satisfies {
  [Key in keyof typeof syncModels]: { readonly prefix: `${Key & string}/` };
};

/** Union of every persisted raw prefix — drives generic dispatchers. */
export type IDBKeys = keyof typeof SYNC_MODEL;

/** The precise model (schema + key) bound to one slug. */
export type SyncModelFor<Slug extends IDBKeys> = (typeof SYNC_MODEL)[Slug];

/** The synced value type for a slug. */
export type SyncedValueFor<Slug extends IDBKeys> = z.output<SyncModelFor<Slug>["schema"]>;

/**
 * Every synced entity that can live in the Replicache store. Derived from
 * `SYNC_MODEL` so the union cannot drift from the registry.
 */
export type SyncedEntity = {
  [Slug in IDBKeys]: SyncedValueFor<Slug>;
}[IDBKeys];

/** All entity slugs as a runtime array — server iterates over this. */
// SAFETY: Object.keys preserves every literal object key and adds no keys.
export const IDB_KEY_NAMES = Object.keys(SYNC_MODEL) as IDBKeys[];

/**
 * Round-trip through `JSON.stringify`/`JSON.parse` to coerce any
 * Drizzle/server-shaped value into Replicache's strict `ReadonlyJSONValue`.
 * The serialisation step strips methods, `undefined`, prototypes, and other
 * non-JSON artefacts; the parse step returns a plain JSON tree that
 * satisfies the Replicache boundary.
 */
export function normalizeToReadonlyJSON<T>(value: T): ReadonlyJSONValue {
  // SAFETY: JSON.parse returns `unknown`; the round-trip guarantees a valid
  // JSON tree, which is exactly ReadonlyJSONValue.
  return JSON.parse(JSON.stringify(value)) as ReadonlyJSONValue;
}

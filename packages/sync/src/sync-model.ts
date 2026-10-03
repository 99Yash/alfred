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
 * `storageKeyForId` builds one from the model's typed identity. Scan prefixes
 * stay private to this module. No public key operation returns a bare id-part,
 * so a caller cannot pass the result of a key builder to Replicache by mistake.
 */
type SyncSchema = z.ZodType<{ rowVersion: number }, unknown>;

export type SyncStringKey<TSchema extends SyncSchema> = {
  [Key in keyof z.output<TSchema>]-?: z.output<TSchema>[Key] extends string ? Key : never;
}[keyof z.output<TSchema>] &
  string;

export type SyncIdentity<
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> = Record<TKeys[number], string>;

export type SyncIdentityPrefix<
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> = TKeys extends readonly [SyncStringKey<TSchema>, SyncStringKey<TSchema>]
  ? Record<TKeys[0], string>
  : never;

/**
 * One light version projection after validation: the CVR id the identity tuple
 * produces, plus the row version that id is at. It says nothing about the row's
 * values, so it can acknowledge membership the client already holds.
 */
export interface SyncPullVersion {
  id: string;
  rowVersion: number;
}

export interface SyncEntityModel<
  Prefix extends string,
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> {
  readonly slug: Prefix;
  /** Type carrier for SyncModelFor and server projection derivation. */
  readonly schema: TSchema;
  /**
   * Rebuild a storage key from the bare identity stored in a CVR snapshot.
   * The delete-diff loop in `packages/http/src/sync/pull.ts` is the only
   * intended caller.
   */
  storageKeyForCVRId(id: string): `${Prefix}/${string}`;
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
  /**
   * Validate one *light* version projection — the ordered identity tuple plus
   * `rowVersion` — and derive its CVR id from the same tuple.
   *
   * `parsePullValue` is the full wire gate: it needs every schema field, so a
   * caller must first have read the whole row. This parser is what the server
   * pull runs over its membership query, where the row's full values were
   * deliberately never selected. It therefore builds its own narrow schema from
   * `key` instead of narrowing `schema`, which also keeps it working for a
   * discriminated-union schema such as `triagetag` without a `.pick()`.
   *
   * "Light" describes what it validates, not what a projection may carry. A
   * reader whose membership is decided in JS selects the few extra columns that
   * test reads; this parser ignores every key outside `key` and `rowVersion`.
   *
   * It does NOT decide whether a value may reach the client — only whether a
   * projection is a well-formed identity plus a number, so the pull can diff
   * membership and load the changed rows for full validation. Throws a
   * `ZodError` for a malformed projection, which the pull treats as one
   * skippable row.
   */
  parsePullVersion(input: unknown): SyncPullVersion;
}

/** The one place a persisted CVR id's parts become a `/`-joined string. */
function joinIdentity(parts: readonly string[]): string {
  return parts.join("/");
}

function identityPart<TKey extends string>(
  value: Record<TKey, string>,
  keys: readonly TKey[],
): string {
  return joinIdentity(keys.map((key) => value[key]));
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

  const identityOf = (value: z.output<TSchema>): SyncIdentity<TSchema, TKeys> => {
    // SAFETY: TKeys can contain only string-valued keys from TSchema's output,
    // so the parsed value satisfies the identity record by construction.
    return value as z.output<TSchema> & SyncIdentity<TSchema, TKeys>;
  };

  // SAFETY: Prefix is the literal type of prefixRaw, so appending `/` produces
  // the exact template-literal type declared here.
  const prefix = `${prefixRaw}/` as `${Prefix}/`;

  const storageKeyForCVRId = (id: string): `${Prefix}/${string}` => {
    // SAFETY: prefix carries Prefix and id is the persisted identity suffix,
    // so their concatenation has the declared storage-key template shape.
    return `${prefix}${id}` as `${Prefix}/${string}`;
  };

  const storageKeyForId = (id: SyncIdentity<TSchema, TKeys>): `${Prefix}/${string}` => {
    return storageKeyForCVRId(identityPart(id, key));
  };

  const parseSynced = (values: readonly unknown[]): z.output<TSchema>[] => {
    const parsed: z.output<TSchema>[] = [];

    for (const value of values) {
      const result = schema.safeParse(value);

      if (result.success) parsed.push(result.data);
    }

    return parsed;
  };

  // The narrow version gate. Built from `key` rather than from `schema` so it
  // stays a two-field contract for every model, union schema included.
  const versionRecordSchema = z.record(z.string(), z.unknown());
  const identityValueSchema = z.string();
  const rowVersionSchema = z.number();

  const parsePullVersion = (input: unknown): SyncPullVersion => {
    const record = versionRecordSchema.parse(input);
    const identity = key.map((name) => identityValueSchema.parse(record[name]));

    return {
      id: joinIdentity(identity),
      rowVersion: rowVersionSchema.parse(record.rowVersion),
    };
  };

  return {
    slug: prefixRaw,
    schema,
    storageKeyForCVRId,
    storageKeyForId,
    storageKeyFor: (entity) => storageKeyForId(identityOf(entity)),
    scan: async (tx) => {
      const values = await tx.scan({ prefix }).values().toArray();

      return parseSynced(values);
    },
    scanPrefix: async (tx, id) => {
      const boundedPrefix = `${prefix}${identityPart(id, [key[0]])}/`;
      const values = await tx.scan({ prefix: boundedPrefix }).values().toArray();

      return parseSynced(values);
    },
    get: async (tx, id) => {
      const value = await tx.get(storageKeyForId(id));

      if (value === undefined) return null;

      return parseSynced([value])[0] ?? null;
    },
    put: async (tx, input) => {
      const value = schema.parse(input);
      await tx.set(storageKeyForId(identityOf(value)), normalizeToReadonlyJSON(value));
    },
    del: async (tx, id) => {
      await tx.del(storageKeyForId(id));
    },
    parsePullValue: (input: unknown) => {
      const value = schema.parse(input);
      const valueIdentity = identityOf(value);
      const storageKey = storageKeyForId(valueIdentity);

      return {
        id: identityPart(valueIdentity, key),
        storageKey,
        rowVersion: value.rowVersion,
        value,
      };
    },
    parsePullVersion,
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
  [Key in keyof typeof syncModels]: { readonly slug: Key & string };
};

/** Union of every persisted raw prefix — drives generic dispatchers. */
export type IDBKeys = keyof typeof SYNC_MODEL;

/** The precise schema and operations bound to one slug. */
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
export const IDB_KEY_NAMES =
  /* SAFETY: Object.keys preserves every literal object key and adds no keys. */
  Object.keys(SYNC_MODEL) as IDBKeys[];

/**
 * Round-trip through `JSON.stringify`/`JSON.parse` to coerce any
 * Drizzle/server-shaped value into Replicache's strict `ReadonlyJSONValue`.
 * The serialisation step strips methods, `undefined`, prototypes, and other
 * non-JSON artefacts; the parse step returns a plain JSON tree that
 * satisfies the Replicache boundary.
 */
function normalizeToReadonlyJSON<T>(value: T): ReadonlyJSONValue {
  // SAFETY: JSON.parse returns `unknown`; the round-trip guarantees a valid
  // JSON tree, which is exactly ReadonlyJSONValue.
  return JSON.parse(JSON.stringify(value)) as ReadonlyJSONValue;
}

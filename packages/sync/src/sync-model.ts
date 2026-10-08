import { getPath } from "@alfred/contracts";
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
 * One synced entity: its key prefix, its schema, and its key builders.
 * The schema is the allowlist of fields the browser sees. Do not make it strict:
 * a new database-only column would then make every row fail to parse.
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

export interface SyncEntityModel<
  Prefix extends string,
  TSchema extends SyncSchema,
  TKeys extends readonly SyncStringKey<TSchema>[],
> {
  readonly slug: Prefix;
  /** Type carrier for SyncModelFor and server projection derivation. */
  readonly schema: TSchema;
  /** Rebuild a storage key from the bare identity in a CVR snapshot. */
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
   * Validate only the identity and `rowVersion`, and derive the CVR id.
   * It does not decide whether a value may reach the client; `parsePullValue` does.
   * Throws a `ZodError` on a malformed row.
   */
  parsePullVersion(
    input: unknown,
  ): Pick<
    ReturnType<SyncEntityModel<Prefix, TSchema, TKeys>["parsePullValue"]>,
    "id" | "rowVersion"
  >;
}

function identityPart<TKey extends string>(
  value: Record<TKey, string>,
  keys: readonly TKey[],
): string {
  return keys.map((key) => value[key]).join("/");
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
    // SAFETY: TKeys holds only string-valued keys of TSchema's output.
    return value as z.output<TSchema> & SyncIdentity<TSchema, TKeys>;
  };

  const prefix: `${Prefix}/` = `${prefixRaw}/`;

  const storageKeyForCVRId = (id: string): `${Prefix}/${string}` => {
    return `${prefix}${id}`;
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

  // Built from field shapes, not from `schema`, so union schemas work too.
  const identityValueSchema = z.string();
  const rowVersionSchema = z.number();

  const parsePullVersion = (input: unknown) => {
    return {
      id: key.map((name) => identityValueSchema.parse(getPath(input, name))).join("/"),
      rowVersion: rowVersionSchema.parse(getPath(input, "rowVersion")),
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
 * Every synced entity. The key order matters: `IDB_KEY_NAMES` and the server
 * patch dispatcher keep it. Do not reorder existing entries.
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

export type IDBKeys = keyof typeof SYNC_MODEL;

export type SyncModelFor<Slug extends IDBKeys> = (typeof SYNC_MODEL)[Slug];

export type SyncedValueFor<Slug extends IDBKeys> = z.output<SyncModelFor<Slug>["schema"]>;

export type SyncedEntity = {
  [Slug in IDBKeys]: SyncedValueFor<Slug>;
}[IDBKeys];

export const IDB_KEY_NAMES =
  /* SAFETY: Object.keys preserves every literal object key and adds no keys. */
  Object.keys(SYNC_MODEL) as IDBKeys[];

/** JSON round-trip a server value into a plain `ReadonlyJSONValue`. */
function normalizeToReadonlyJSON<T>(value: T): ReadonlyJSONValue {
  // SAFETY: a JSON round-trip yields a JSON tree, which is ReadonlyJSONValue.
  return JSON.parse(JSON.stringify(value)) as ReadonlyJSONValue;
}

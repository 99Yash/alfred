import type { ReadonlyJSONValue } from "replicache";
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
 * `storageKeyFor` derives a full key (`todo/abc`) from a parsed entity;
 * `storageKeyForId` builds one from a raw id-part; `prefix` is the scan prefix
 * (`todo/`). No public key operation returns a bare id-part, so a caller cannot
 * pass the result of a key builder to Replicache by mistake.
 */
type SyncSchema = z.ZodType<{ rowVersion: number }, unknown>;

interface SyncEntityDefinition<TSchema extends SyncSchema = SyncSchema> {
  schema: TSchema;
  idOf: (entity: z.output<TSchema>) => string;
}

type ValidModelPrefix<Prefix extends string> = string extends Prefix
  ? never
  : Prefix extends ""
    ? never
    : Prefix extends Lowercase<Prefix>
      ? Prefix extends `${string}/${string}`
        ? never
        : unknown
      : never;

interface SyncEntityModel<Prefix extends string = string, TSchema extends SyncSchema = SyncSchema> {
  prefix: `${Prefix}/`;
  schema: TSchema;
  storageKeyForId: (id: string) => `${Prefix}/${string}`;
  storageKeyFor: (entity: z.output<TSchema>) => `${Prefix}/${string}`;
  parsePullValue: (input: unknown) => {
    id: string;
    rowVersion: number;
    value: z.output<TSchema>;
  };
}

/**
 * Describe one registry entry before `defineModels` binds its persisted prefix.
 * Keeping this as a generic constructor types `idOf` against the selected
 * schema without repeating its output type.
 */
function model<TSchema extends SyncSchema>(
  schema: TSchema,
  idOf: (entity: z.output<TSchema>) => string,
): SyncEntityDefinition<TSchema> {
  return { schema, idOf };
}

type ModelDefinitionContract = {
  schema: SyncSchema;
  idOf: (entity: never) => string;
};

type InvalidModelPrefixes<Definitions extends Record<string, ModelDefinitionContract>> = {
  [Prefix in keyof Definitions & string]: ValidModelPrefix<Prefix> extends never ? Prefix : never;
}[keyof Definitions & string];

type DefinedModels<Definitions extends Record<string, ModelDefinitionContract>> = {
  [Prefix in keyof Definitions & string]: SyncEntityModel<Prefix, Definitions[Prefix]["schema"]>;
};

interface BoundSyncModels {
  [prefix: string]: SyncEntityModel;
}

function bindModel<const Prefix extends string, TSchema extends SyncSchema>(
  prefixRaw: Prefix,
  definition: SyncEntityDefinition<TSchema>,
): SyncEntityModel<Prefix, TSchema> {
  const { schema, idOf } = definition;
  // SAFETY: Prefix is the literal type of prefixRaw, so appending `/` produces
  // the exact template-literal type declared here.
  const prefix = `${prefixRaw}/` as `${Prefix}/`;
  const storageKeyForId = (id: string): `${Prefix}/${string}` => {
    // SAFETY: prefixRaw contains no `/`; this appends one separator and the id.
    return `${prefixRaw}/${id}` as `${Prefix}/${string}`;
  };
  return {
    prefix,
    schema,
    storageKeyForId,
    storageKeyFor: (entity: z.output<TSchema>) => storageKeyForId(idOf(entity)),
    parsePullValue: (input: unknown) => {
      const value = schema.parse(input);
      return { id: idOf(value), rowVersion: value.rowVersion, value };
    },
  };
}

/**
 * Bind each model to its object key, which is also its persisted raw prefix.
 * A prefix therefore has one declaration and cannot drift from its registry
 * slot. Invalid, widened, empty, uppercase, or slash-containing keys fail at
 * the call site.
 */
function defineModels<const Definitions extends Record<string, ModelDefinitionContract>>(
  definitions: Definitions &
    ([InvalidModelPrefixes<Definitions>] extends [never] ? unknown : never),
): DefinedModels<Definitions>;
function defineModels(definitions: Record<string, ModelDefinitionContract>): BoundSyncModels {
  const models: BoundSyncModels = {};
  for (const [prefixRaw, definition] of Object.entries(definitions)) {
    // SAFETY: every entry was created by model(), which binds idOf to its own
    // schema. Object.entries erases that correlation, but does not change it.
    models[prefixRaw] = bindModel(prefixRaw, definition as SyncEntityDefinition<SyncSchema>);
  }
  return models;
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
export const SYNC_MODEL = defineModels({
  note: model(syncedNoteSchema, (note) => note.id),
  fact: model(syncedFactSchema, (fact) => fact.id),
  briefing: model(syncedBriefingSchema, (briefing) => `${briefing.briefingDate}/${briefing.slot}`),
  pref: model(syncedPreferenceSchema, (preference) => preference.key),
  skill: model(syncedSkillSchema, (skill) => skill.id),
  skillrev: model(syncedSkillRevisionSchema, (revision) => revision.id),
  skillrun: model(syncedSkillRunSchema, (run) => run.id),
  actionstaging: model(syncedActionStagingSchema, (action) => action.id),
  actionpolicy: model(syncedActionPolicySchema, (policy) => policy.userId),
  workflow: model(syncedWorkflowSchema, (workflow) => workflow.slug),
  todo: model(syncedTodoSchema, (todo) => todo.id),
  chatthread: model(syncedChatThreadSchema, (thread) => thread.id),
  chatmsg: model(syncedChatMessageSchema, (message) => message.id),
  chatatt: model(syncedChatAttachmentSchema, (attachment) => attachment.id),
  artifact: model(syncedArtifactSchema, (artifact) => artifact.id),
  triagetag: model(syncedTriageTagSchema, (tag) => tag.threadId),
});

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

export interface ParsedSyncPullValue<Slug extends IDBKeys> {
  id: string;
  rowVersion: number;
  value: SyncedValueFor<Slug>;
}

/** Parse one pull projection through the schema and identity bound to `slug`. */
export function parseSyncPullValue<Slug extends IDBKeys>(
  slug: Slug,
  input: unknown,
): ParsedSyncPullValue<Slug> {
  // SAFETY: the selected registry entry owns both the schema and its identity
  // function. TypeScript widens a generic indexed access to the union of all
  // entries, but the runtime lookup and the requested Slug are the same value.
  return SYNC_MODEL[slug].parsePullValue(input) as ParsedSyncPullValue<Slug>;
}

/** All entity slugs as a runtime array — server iterates over this. */
// SAFETY: defineModels preserves every literal object key and adds no keys.
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

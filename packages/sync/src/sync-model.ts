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
interface SyncEntityModel<
  TSchema extends z.ZodType<{ rowVersion: number }, unknown> = z.ZodType<
    { rowVersion: number },
    unknown
  >,
> {
  prefix: string;
  schema: TSchema;
  storageKeyForId: (id: string) => string;
  storageKeyFor: (entity: z.output<TSchema>) => string;
  parsePullValue: (input: unknown) => {
    id: string;
    rowVersion: number;
    value: z.output<TSchema>;
  };
}

/**
 * Build one registry entry so `idOf` is typed against the schema's output —
 * the loose `satisfies`+object-literal alternative would type every `idOf` as
 * `(entity: any) => string` and lose per-schema precision.
 */
function model<TSchema extends z.ZodType<{ rowVersion: number }, unknown>>(
  prefixRaw: string,
  schema: TSchema,
  idOf: (entity: z.output<TSchema>) => string,
): SyncEntityModel<TSchema> {
  const prefix = `${prefixRaw}/`;
  return {
    prefix,
    schema,
    storageKeyForId: (id: string) => `${prefix}${id}`,
    storageKeyFor: (entity: z.output<TSchema>) => `${prefix}${idOf(entity)}`,
    parsePullValue: (input: unknown) => {
      const value = schema.parse(input);
      return { id: idOf(value), rowVersion: value.rowVersion, value };
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
export const SYNC_MODEL = {
  NOTE: model("note", syncedNoteSchema, (n) => n.id),
  FACT: model("fact", syncedFactSchema, (f) => f.id),
  BRIEFING: model("briefing", syncedBriefingSchema, (b) => `${b.briefingDate}/${b.slot}`),
  PREFERENCE: model("pref", syncedPreferenceSchema, (p) => p.key),
  SKILL: model("skill", syncedSkillSchema, (s) => s.id),
  SKILL_REVISION: model("skillrev", syncedSkillRevisionSchema, (r) => r.id),
  SKILL_RUN: model("skillrun", syncedSkillRunSchema, (r) => r.id),
  ACTION_STAGING: model("actionstaging", syncedActionStagingSchema, (a) => a.id),
  ACTION_POLICY: model("actionpolicy", syncedActionPolicySchema, (p) => p.userId),
  WORKFLOW: model("workflow", syncedWorkflowSchema, (w) => w.slug),
  TODO: model("todo", syncedTodoSchema, (t) => t.id),
  CHAT_THREAD: model("chatthread", syncedChatThreadSchema, (t) => t.id),
  CHAT_MESSAGE: model("chatmsg", syncedChatMessageSchema, (m) => m.id),
  CHAT_ATTACHMENT: model("chatatt", syncedChatAttachmentSchema, (a) => a.id),
  ARTIFACT: model("artifact", syncedArtifactSchema, (a) => a.id),
  TRIAGE_TAG: model("triagetag", syncedTriageTagSchema, (t) => t.threadId),
} satisfies Record<string, SyncEntityModel>;

/** Union of every entity slug — drives generic dispatchers (server + types). */
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

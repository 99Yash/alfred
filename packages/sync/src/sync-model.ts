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
 * that owns its shape, and the function that derives a row's IDB id-part from
 * a synced entity `k`.
 *
 * This is the single source of truth for "which field of a synced entity is
 * its IDB id". The server pull (`syncEntity` in `@alfred/http`), the client
 * mutators, and the key builders all read `key` from here — so a server that
 * keys triage tags by `id` and a client that keys them by `threadId` can no
 * longer compile.
 *
 * `key: (k) => k.id` returns a plain id; composite ids (briefing
 * `${date}/${slot}`, pref `key`) stay explicit per entity.
 */
interface SyncEntityModel<TSchema extends z.ZodTypeAny> {
  prefix: string;
  schema: TSchema;
  key: (entity: z.output<TSchema>) => string;
}

/**
 * Build one registry entry so `key` is typed against the schema's output —
 * the loose `satisfies`+object-literal alternative would type every `key` as
 * `(entity: any) => string` and lose per-schema precision.
 */
function model<TSchema extends z.ZodTypeAny>(
  prefix: string,
  schema: TSchema,
  key: (entity: z.output<TSchema>) => string,
): SyncEntityModel<TSchema> {
  return { prefix, schema, key };
}

/**
 * Single registry of every synced entity (ADR-…).
 *
 * `IDB_KEY`, `IDBKeys`, and `SyncedEntity` are derived from this map, so
 * adding an entity is one entry here plus one fetcher and one mutator — no
 * parallel schema/key/SyncedEntity-union bookkeeping.
 *
 * The literal order is load-bearing: `IDB_KEY_NAMES` (and therefore the
 * server's patch-operation order in `SYNC_ENTITIES`) is `Object.keys` of this
 * object, so keep the current order stable when adding entries.
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
} satisfies Record<string, SyncEntityModel<z.ZodTypeAny>>;

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

/** All entity slugs as a runtime array — server iterates over this. */
export const IDB_KEY_NAMES = Object.keys(SYNC_MODEL) as IDBKeys[];

function constructIDBKey(parts: (string | null | undefined | number)[]): string {
  return parts.filter((p) => p !== undefined && p !== null).join("/");
}

/**
 * Replicache IDB key builders, derived from `SYNC_MODEL` so the prefix and the
 * "what is the id" rule cannot drift from the entity definitions.
 *
 * Calling with `{}` produces the *prefix* (`note/`) for `tx.scan({ prefix })`;
 * calling with `{ id }` produces a single-row key (`note/abc`). Same call site
 * for both — the prefix is the model prefix with no trailing segment.
 */
export const IDB_KEY = Object.fromEntries(
  IDB_KEY_NAMES.map((slug) => [
    slug,
    ({ id = "" }: { id?: string }) => constructIDBKey([SYNC_MODEL[slug].prefix, id]),
  ]),
) as { [Slug in IDBKeys]: (args: { id?: string }) => string };

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

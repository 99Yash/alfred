import type { ReadonlyJSONValue } from "replicache";

/**
 * Single registry of every Replicache IDB key shape.
 *
 * Each entry is a function that returns a key. Calling with `{}` produces
 * the *prefix* (`note/`, `fact/`) for `tx.scan({ prefix })`; calling with
 * `{ id }` produces a single-row key (`note/abc`, `fact/abc`). Same call
 * site for both — eliminates the per-entity `xPrefix` constant + `xKey()`
 * function pair.
 *
 * Why one map: the server's pull dispatcher (`packages/api/.../pull.ts`)
 * iterates `Object.keys(IDB_KEY)` to emit patches generically — adding a
 * new synced entity is one line here, no per-entity loop on the server.
 *
 * Pattern adapted from the dimension/replicache-cvr reference repo.
 */

function constructIDBKey(parts: (string | null | undefined | number)[]): string {
  return parts.filter((p) => p !== undefined && p !== null).join("/");
}

export const IDB_KEY = {
  /** `note/` (prefix scan) or `note/{id}` (single row). */
  NOTE: ({ id = "" }: { id?: string }) => constructIDBKey(["note", id]),
  /** `fact/` (prefix scan) or `fact/{id}` (single row). */
  FACT: ({ id = "" }: { id?: string }) => constructIDBKey(["fact", id]),
  /** `briefing/` (prefix scan) or `briefing/{briefingDate}/{slot}` (single row). */
  BRIEFING: ({ id = "" }: { id?: string }) => constructIDBKey(["briefing", id]),
  /**
   * `pref/` (prefix scan) or `pref/{key}` (single row).
   *
   * `id` here is the user-facing preference key (`tone`,
   * `briefing.delivery_hour`, …) — see `SyncedPreference`. Server-side
   * uniqueness is `(user_id, key)`, so using `key` as the IDB id keeps
   * the client and server agreeing without an extra lookup.
   */
  PREFERENCE: ({ id = "" }: { id?: string }) => constructIDBKey(["pref", id]),
  /** `skill/` (prefix scan) or `skill/{id}` (single row). */
  SKILL: ({ id = "" }: { id?: string }) => constructIDBKey(["skill", id]),
  /** `skillrev/` (prefix scan) or `skillrev/{id}` (single row). */
  SKILL_REVISION: ({ id = "" }: { id?: string }) => constructIDBKey(["skillrev", id]),
  /** `skillrun/` (prefix scan) or `skillrun/{id}` (single row). */
  SKILL_RUN: ({ id = "" }: { id?: string }) => constructIDBKey(["skillrun", id]),
  /** `actionstaging/` (prefix scan) or `actionstaging/{id}` (single row). */
  ACTION_STAGING: ({ id = "" }: { id?: string }) => constructIDBKey(["actionstaging", id]),
  /**
   * `actionpolicy/` (prefix scan) or `actionpolicy/{userId}` (single row).
   *
   * One row per user — the whole `user_action_policies` row is a single
   * synced entity keyed by `userId` (m13 Phase 8c). The web derives each
   * integration's mode from `integration_rules[slug].mode ?? default_mode`
   * client-side via `resolveIntegrationMode`.
   */
  ACTION_POLICY: ({ id = "" }: { id?: string }) => constructIDBKey(["actionpolicy", id]),
  /** `todo/` (prefix scan) or `todo/{id}` (single row). Flat — no day prefix. */
  TODO: ({ id = "" }: { id?: string }) => constructIDBKey(["todo", id]),
  /** `chatthread/` (prefix scan) or `chatthread/{id}` (single row). */
  CHAT_THREAD: ({ id = "" }: { id?: string }) => constructIDBKey(["chatthread", id]),
  /** `chatmsg/` (prefix scan) or `chatmsg/{id}` (single row). Flat — filter by threadId client-side. */
  CHAT_MESSAGE: ({ id = "" }: { id?: string }) => constructIDBKey(["chatmsg", id]),
  /**
   * `triagetag/` (prefix scan) or `triagetag/{threadId}` (single row).
   *
   * Keyed by the Gmail `source_thread_id` (one tag per thread) so the override
   * mutator's optimistic write addresses the row without an id lookup, matching
   * how `email_triage` is keyed (rfc-triage-tags.md).
   */
  TRIAGE_TAG: ({ id = "" }: { id?: string }) => constructIDBKey(["triagetag", id]),
  /**
   * `workflow/` (prefix scan) or `workflow/{slug}` (single row).
   *
   * Keyed by the workflow's `slug` (unique per user, the same value
   * `agent_runs.workflow_slug` joins on and the `/workflows/$workflow`
   * route addresses) so the authoring editor's optimistic write can
   * target a row without an id lookup.
   */
  WORKFLOW: ({ id = "" }: { id?: string }) => constructIDBKey(["workflow", id]),
} as const;

/** Union of every entity slug in the registry — drives generic dispatchers. */
export type IDBKeys = keyof typeof IDB_KEY;

/** All entity slugs as a runtime array — server iterates over this. */
export const IDB_KEY_NAMES = Object.keys(IDB_KEY) as IDBKeys[];

/**
 * Cast through `ReadonlyJSONValue` — Replicache's `tx.set` is strict and
 * Drizzle/server-shaped types don't always satisfy it on the nose. The
 * runtime value is always JSON-serializable; the cast is just to make
 * TS happy at the boundary.
 */
export function normalizeToReadonlyJSON<T>(value: T): ReadonlyJSONValue {
  return value as unknown as ReadonlyJSONValue;
}

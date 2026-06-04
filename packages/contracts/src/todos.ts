/**
 * Todos contract (ADR-0050). Zero Node deps — safe to import from `apps/web`,
 * `packages/db` (`.$type<T>()` columns), `packages/api`, and `packages/sync`.
 *
 * A todo is the first *persisted* materialization of the open-loop model
 * (ADR-0048 keeps loops ephemeral at briefing compose-time). One status-driven
 * `todos` table; v1 is passive — Alfred authors + assists but never executes.
 * The enums + the cross-source `sources` ref shape live here so the table
 * column types, the Replicache read schema, and the `system.suggest_todo`
 * write tool all agree by construction.
 */

import { z } from "zod";

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * `suggested` — Alfred-proposed, not yet accepted (renders in *Suggestions*).
 * `open` — a live todo (user-added, or a promoted suggestion).
 * `done` — completed (`completed_at` set; lingers 7 days in the sync window).
 * `dismissed` — declined/dropped (terminal; never synced to the client).
 *
 * Deliberately no `running`/`interrupted`/`needs_attention`/`error` at v1 —
 * those are the deferred agent-executable run-states.
 */
export const TODO_STATUSES = ["suggested", "open", "done", "dismissed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export const todoStatusSchema = z.enum(TODO_STATUSES);

// ─── Authorship ──────────────────────────────────────────────────────────

/** Who created the row. Survives promotion so suggestion acceptance is measurable later. */
export const TODO_CREATED_BY = ["user", "agent"] as const;
export type TodoCreatedBy = (typeof TODO_CREATED_BY)[number];
export const todoCreatedBySchema = z.enum(TODO_CREATED_BY);

// ─── Forward-compat: executor + kind ───────────────────────────────────────

/**
 * `user` in passive v1; `agent` is the deferred agent-executable path
 * (spawns an `agent_runs` run through the boss runtime). Inert at v1.
 */
export const TODO_EXECUTORS = ["user", "agent"] as const;
export type TodoExecutor = (typeof TODO_EXECUTORS)[number];
export const todoExecutorSchema = z.enum(TODO_EXECUTORS);

/** `task` in v1; executor-specific variants land later without a migration. */
export const TODO_KINDS = ["task"] as const;
export type TodoKind = (typeof TODO_KINDS)[number];
export const todoKindSchema = z.enum(TODO_KINDS);

// ─── Cross-source provenance ───────────────────────────────────────────────

/**
 * One typed provenance ref on a todo. Canonical identity is
 * `(provider, kind, id)`; `url` is display/navigation metadata only and does
 * not participate in dedup. `provider`/`kind` are open strings (not the closed
 * integration enum) so coverage widens automatically as `integration_activity`
 * producers land, per ADR-0050 ("source-agnostic by construction").
 */
export const todoSourceSchema = z
  .object({
    provider: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    id: z.string().min(1).max(512),
    url: z.string().url().max(2_048).optional(),
  })
  .strict();
export type TodoSource = z.infer<typeof todoSourceSchema>;

export const todoSourcesSchema = z.array(todoSourceSchema).max(64);

/** Canonical dedup key for a source ref. `url` is intentionally excluded. */
export function todoSourceKey(source: TodoSource): string {
  return JSON.stringify([source.provider, source.kind, source.id]);
}

/**
 * Merge incoming refs into an existing set, appending only those whose
 * `(provider, kind, id)` identity is not already present. Order-stable: the
 * existing refs keep their position, new ones append. Used by the
 * `suggest_todo` idempotency guard and the optimistic client merge.
 */
export function mergeTodoSources(existing: TodoSource[], incoming: TodoSource[]): TodoSource[] {
  const seen = new Set(existing.map(todoSourceKey));
  const merged = [...existing];
  for (const ref of incoming) {
    const key = todoSourceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

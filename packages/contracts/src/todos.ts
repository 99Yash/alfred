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

import { deriveLoopEntityRef } from "./loop-key";

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * `suggested` — Alfred-proposed, not yet accepted (renders in *Suggestions*).
 * `open` — a live todo (user-added, or a promoted suggestion).
 * `done` — completed (`completed_at` set; lingers 2 days in the sync window).
 * `dismissed` — declined/dropped (terminal; never synced to the client).
 * `cleared` — a `done` todo the user personally removed from the rail before
 *   the done-sync window expired (terminal; never synced to the client). Distinct
 *   from `dismissed` so accept/dismiss vs done-then-clear stay measurable.
 *
 * Deliberately no `running`/`interrupted`/`needs_attention`/`error` at v1 —
 * those are the deferred agent-executable run-states.
 */
export const TODO_STATUSES = ["suggested", "open", "done", "dismissed", "cleared"] as const;
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

/** Upper bound the `todos.sources` column + sync read schema enforce. */
export const TODO_SOURCES_MAX = 64;

/** A gmail `thread` ref — the per-notification transport id, the evictable kind. */
function isGmailThreadRef(source: TodoSource): boolean {
  return source.provider === "gmail" && source.kind === "thread";
}

/**
 * Bound a source set so a high-frequency recurring loop can't grow one todo's
 * `sources` past {@link TODO_SOURCES_MAX} and silently break sync (#355). When a
 * recurring signal (a GitHub PR, Linear issue, or tracker task) re-notifies on a
 * NEW Gmail thread each time, {@link suggestTodo} merges every re-notification
 * onto one todo via its stable `loop` ref — but each merge also appends that
 * email's fresh gmail `thread` ref, so an active loop accretes thread refs
 * without bound and eventually trips the `max(64)` on the sync read schema,
 * after which the todo stops syncing to the client.
 *
 * Identity-bearing refs — everything that is NOT a gmail `thread` — win over
 * transport refs. Gmail `thread` refs are evicted oldest-first (merge appends
 * newest last), so the reverse auto-dismiss linkage (`resolveTodosForGmailSender`,
 * which matches recent threads / the loop's single sender) still resolves. If a
 * caller ever supplies more identity refs than the schema cap allows, this still
 * returns a valid capped array by keeping the newest identity refs; the public
 * tool schema already rejects that shape, but the write helper stays defensive.
 */
export function boundTodoSources(sources: TodoSource[], max = TODO_SOURCES_MAX): TodoSource[] {
  if (sources.length <= max) return sources;
  if (max <= 0) return [];

  const nonThreadCount = sources.filter((s) => !isGmailThreadRef(s)).length;
  if (nonThreadCount >= max) {
    const survivingIdentityIndexes = newestIndexes(sources, (s) => !isGmailThreadRef(s), max);
    return sources.filter((s, i) => !isGmailThreadRef(s) && survivingIdentityIndexes.has(i));
  }

  // Room left for thread refs after every identity-bearing ref is kept.
  const room = max - nonThreadCount;
  // Newest thread refs win: collect their keys from the tail, then filter the
  // original in place so surviving refs keep their relative order.
  const survivingThreadIndexes = newestIndexes(sources, isGmailThreadRef, room);
  return sources.filter((s, i) => !isGmailThreadRef(s) || survivingThreadIndexes.has(i));
}

function newestIndexes(
  sources: readonly TodoSource[],
  predicate: (source: TodoSource) => boolean,
  count: number,
): Set<number> {
  const indexes = new Set<number>();
  for (let i = sources.length - 1; i >= 0 && indexes.size < count; i--) {
    if (predicate(sources[i]!)) indexes.add(i);
  }
  return indexes;
}

/**
 * Provenance sources for a todo minted from a triaged Gmail thread (#355).
 *
 * Always carries the transport `thread` ref — same-thread re-triage dedup, and
 * the reverse linkage `resolveTodosForGmailSender` reads to auto-dismiss a todo
 * when the user acts on its email. When the subject/sender yield a stable
 * real-world ref ({@link deriveLoopEntityRef} — a GitHub PR, Linear issue, or
 * tracker task that re-notifies on a NEW thread each time), it ALSO carries a
 * structured real-world ref so those re-notifications collapse onto one rail
 * todo via the {@link suggestTodo} overlap/merge guard instead of re-minting per
 * email. Unlike briefing's soft continuation hint, this hard persisted key
 * requires sender evidence for structured tracker shapes: a human email whose
 * subject happens to contain `[owner/repo] ... (PR #1)` should not merge rail
 * items.
 */
export function gmailTodoSources(input: {
  threadId: string;
  subject: string | null | undefined;
  sender: string | null | undefined;
}): TodoSource[] {
  const sources: TodoSource[] = [{ provider: "gmail", kind: "thread", id: input.threadId }];
  const loopRef = deriveLoopEntityRef(input.subject, {
    sender: input.sender,
    requireTrackerSender: true,
  });
  if (loopRef) sources.push({ provider: loopRef.provider, kind: loopRef.kind, id: loopRef.id });
  return sources;
}

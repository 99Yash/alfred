/** Todos contract (ADR-0050). v1 is passive: Alfred suggests and assists, but never executes. */

import { z } from "zod";

import { deriveLoopEntityRef } from "./loop-key";

// ─── Status ────────────────────────────────────────────────────────────────

/**
 * `done` stays in the sync window for 2 days. `dismissed` and `cleared` never sync.
 * `cleared` is a `done` todo the user removed, kept apart so dismiss and clear stay measurable.
 */
export const TODO_STATUSES = ["suggested", "open", "done", "dismissed", "cleared"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export const todoStatusSchema = z.enum(TODO_STATUSES);

// ─── Authorship ──────────────────────────────────────────────────────────

/** Survives promotion, so suggestion acceptance stays measurable. */
export const TODO_CREATED_BY = ["user", "agent"] as const;

export type TodoCreatedBy = (typeof TODO_CREATED_BY)[number];

export const todoCreatedBySchema = z.enum(TODO_CREATED_BY);

// ─── Resolution attribution ──────────────────────────────────────────

/**
 * Who made the last status change. NULL only before the first transition.
 * `system` means no user in the loop, such as a reply retraction.
 */
export const TODO_RESOLVED_BY = ["user", "agent", "system"] as const;

export type TodoResolvedBy = (typeof TODO_RESOLVED_BY)[number];

export const todoResolvedBySchema = z.enum(TODO_RESOLVED_BY);

// ─── Forward-compat: executor + kind ───────────────────────────────────────

/** Always `user` in v1. `agent` is reserved for executable todos. */
export const TODO_EXECUTORS = ["user", "agent"] as const;

export type TodoExecutor = (typeof TODO_EXECUTORS)[number];

export const todoExecutorSchema = z.enum(TODO_EXECUTORS);

export const TODO_KINDS = ["task"] as const;

export type TodoKind = (typeof TODO_KINDS)[number];

export const todoKindSchema = z.enum(TODO_KINDS);

// ─── Cross-source provenance ───────────────────────────────────────────────

/**
 * Identity is `(provider, kind, id)`; `url` is display only.
 * `provider` and `kind` are open strings, so new sources need no enum change (ADR-0050).
 */
export const todoSourceSchema = z
  .object({
    provider: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    id: z.string().min(1).max(512),
    url: z.url().max(2_048).optional(),
  })
  .strict();

export type TodoSource = z.infer<typeof todoSourceSchema>;

export const todoSourcesSchema = z.array(todoSourceSchema).max(64);

/** Dedup key for a source ref. Excludes `url`. */
export function todoSourceKey(source: TodoSource): string {
  return JSON.stringify([source.provider, source.kind, source.id]);
}

/**
 * True when the sets share a ref other than a Gmail `thread`.
 * One thread carries many asks, so a resolved todo on it must not silence a later ask.
 */
export function todoSourcesShareIdentityOverlap(
  existing: readonly TodoSource[],
  incoming: readonly TodoSource[],
): boolean {
  const identityKeys = new Set(incoming.filter((ref) => !isGmailThreadRef(ref)).map(todoSourceKey));

  if (identityKeys.size === 0) return false;

  return existing.some((ref) => !isGmailThreadRef(ref) && identityKeys.has(todoSourceKey(ref)));
}

/** Append incoming refs that are not already present. Keeps existing order. */
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

export const TODO_SOURCES_MAX = 64;

function isGmailThreadRef(source: TodoSource): boolean {
  return source.provider === "gmail" && source.kind === "thread";
}

/**
 * Cap `sources` at `max`, or the todo stops syncing (#355). A recurring loop that
 * re-notifies on a new Gmail thread each time appends a thread ref per merge.
 * Drop the oldest thread refs first. If identity refs alone exceed `max`, keep the newest.
 */
export function boundTodoSources(sources: TodoSource[], max = TODO_SOURCES_MAX): TodoSource[] {
  if (sources.length <= max) return sources;

  if (max <= 0) return [];

  const nonThreadCount = sources.filter((s) => !isGmailThreadRef(s)).length;

  if (nonThreadCount >= max) {
    const survivingIdentityIndexes = newestIndexes(sources, (s) => !isGmailThreadRef(s), max);

    return sources.filter((s, i) => !isGmailThreadRef(s) && survivingIdentityIndexes.has(i));
  }

  const room = max - nonThreadCount;
  // Filter the original so survivors keep their order.
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
 * Sources for a todo from a Gmail thread: always the thread ref, plus a loop ref
 * (a PR, a Linear issue) when one is found, so re-notifications merge onto one todo.
 * The loop ref needs a tracker sender, so a human email that quotes `(PR #1)` does not merge.
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

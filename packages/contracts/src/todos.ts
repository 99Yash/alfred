/** Todos contract (ADR-0050). v1 is passive: Alfred suggests and assists, but never executes. */

import { z } from "zod";

import { attributionRecordSchema } from "./attribution";
import { getObjectKindDef, type ObjectStateProvider } from "./integration-objects";
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

// ─── Change attribution (ADR-0115) ───────────────────────────────────

/** Why a todo changed. A new cause is a code change, and `todo_events_cause_valid` checks it. */
export const TODO_CAUSES = [
  /** The user added the todo in the rail. */
  "created",
  /** Alfred proposed the todo. */
  "suggested",
  "completed",
  "reopened",
  "promoted",
  "dismissed",
  "cleared",
  /** The user changed the name or the due date. */
  "edited",
  /** The user replied on the source thread. */
  "reply_detected",
  /** A payment receipt matched the bill. */
  "payment_matched",
  /** A standing instruction now suppresses the sender. */
  "sender_suppressed",
] as const;

export type TodoCause = (typeof TODO_CAUSES)[number];

export const todoCauseSchema = z.enum(TODO_CAUSES);

/**
 * The record of one todo write. Each insert, and each update that changes `status`, `name`, or
 * `due_date`, must carry it, or the `todos` trigger raises. The trigger copies it to `todo_events`
 * and clears the column. Each writer parses the record with this schema before the write.
 */
export const todoAttributionSchema = attributionRecordSchema(todoCauseSchema);

export type TodoAttribution = z.infer<typeof todoAttributionSchema>;

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

  for (const [i, source] of [...sources.entries()].reverse()) {
    if (indexes.size >= count) break;

    if (predicate(source)) indexes.add(i);
  }

  return indexes;
}

/**
 * The `integration_objects` row a mail is about, by its identity tuple (ADR-0092 A1). The tuple,
 * not the row id: the row id is random, and the tuple names the thing (ADR-0111 D2a).
 */
export interface TodoObjectRef {
  provider: ObjectStateProvider;
  kind: string;
  externalId: string;
  url: string | null;
}

/**
 * Sources for a todo from a Gmail thread: always the thread ref, then the object ref when the mail
 * resolved to an `integration_objects` row whose kind declares `todoIdentity`, then a loop ref
 * (a PR, a Linear issue) when the subject names one. Any shared identity ref merges
 * re-notifications onto one todo.
 * The loop ref needs a tracker sender, so a human email that quotes `(PR #1)` does not merge.
 * It stays beside the object ref so that todos minted before the object ref still merge (#917).
 */
export function gmailTodoSources(input: {
  threadId: string;
  subject: string | null | undefined;
  sender: string | null | undefined;
  object: TodoObjectRef | null;
}): TodoSource[] {
  const sources: TodoSource[] = [{ provider: "gmail", kind: "thread", id: input.threadId }];

  const objectRef = input.object ? objectTodoSource(input.object) : null;

  if (objectRef) sources.push(objectRef);

  const loopRef = deriveLoopEntityRef(input.subject, {
    sender: input.sender,
    requireTrackerSender: true,
  });

  if (loopRef) sources.push({ provider: loopRef.provider, kind: loopRef.kind, id: loopRef.id });

  return sources;
}

/**
 * A GitHub PR object ref and a GitHub PR loop ref share `(github, pull_request)` but not an id
 * grammar (`12345` against `owner/repo#12`), so the two never match each other by accident.
 * A bad display `url` must not cost the identity, so it is dropped on its own.
 */
function objectTodoSource(object: TodoObjectRef): TodoSource | null {
  // A target kind gets no ref, so a dismissed CI failure on `main` does not hide the next one.
  if (!getObjectKindDef(object.provider, object.kind)?.todoIdentity) return null;

  const identity = { provider: object.provider, kind: object.kind, id: object.externalId };

  const withUrl = object.url ? todoSourceSchema.safeParse({ ...identity, url: object.url }) : null;

  if (withUrl?.success) return withUrl.data;

  const bare = todoSourceSchema.safeParse(identity);

  return bare.success ? bare.data : null;
}

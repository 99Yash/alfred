import {
  normalizeEmailAddress,
  parseGmailDocumentMetadata,
  resolveTodoIdsSchema,
  todoAttributionSchema,
  todoSourcesSchema,
  LIVE_TODO_STATUSES,
  type TodoAttribution,
  type TodoSource,
  type TodoStatus,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, todos } from "@alfred/db/schemas";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";

/** Live statuses a dismissal may target. */
const liveTodoStatusSchema = z.enum(LIVE_TODO_STATUSES);

const resolveTodosForGmailSourceArgsSchema = z
  .object({
    userId: z.string().min(1),
    senderEmail: z.string().nullish(),
    sourceThreadId: z.string().nullish(),
    /** Exact todo allowlist for a caller with narrower provenance. Re-applied in the UPDATE. */
    todoIds: z.array(z.string().min(1)).min(1).optional(),
    accountId: z.string().nullable().optional(),
    /**
     * Statuses to retract; defaults to both. `close-loop-todos` passes `["suggested"]`:
     * it may drop an unpromoted proposal, never a todo the user promoted to `open`.
     */
    statuses: z.array(liveTodoStatusSchema).min(1).optional(),
  })
  .refine((data) => data.todoIds === undefined || data.sourceThreadId != null, {
    message: "Pass todoIds only alongside sourceThreadId.",
  });

export type ResolveTodosForGmailSourceArgs = z.infer<typeof resolveTodosForGmailSourceArgsSchema>;

export type ResolveTodosForGmailSourceResult =
  | {
      ok: true;
      status: "dismissed" | "not_found";
      dismissedCount: number;
      todoIds: string[];
      matchedThreadIds: string[];
      /** The write's `note`, else its `cause`. Echoed for the model and the log. */
      auditReason: string | null;
    }
  | {
      ok: false;
      status: "needs_clarification";
      reason: "missing_source_or_sender";
      message: string;
      /** Echoed for logging. Never persisted. */
      auditReason: string | null;
    };

interface CandidateTodo {
  id: string;
  status: z.infer<typeof liveTodoStatusSchema>;
  threadIds: string[];
}

interface GmailThreadMetadata {
  sourceThreadId: string;
  accountIds: Set<string | null>;
  senderEmails: Set<string>;
}

/**
 * Dismiss live Gmail-sourced todos by source: by `sourceThreadId` (`close-loop-todos`,
 * payment match), by `senderEmail`/`accountId` (`system.resolve_todo`), or a thread plus one
 * sender scope. `todoIds` can narrow a thread call further. All dismissals are one write.
 *
 * `attribution` is the ADR-0115 record of the dismissal. It has no default: each caller names
 * its actor, and the `todos` trigger fails a write without one.
 */
export async function resolveTodosForGmailSource(
  args: ResolveTodosForGmailSourceArgs,
  attribution: TodoAttribution,
): Promise<ResolveTodosForGmailSourceResult> {
  const parsed = resolveTodosForGmailSourceArgsSchema.parse(args);
  const senderEmail = normalizeEmailAddress(parsed.senderEmail);
  const sourceThreadId = normalizeOptional(parsed.sourceThreadId);
  const requestedTodoIds = parsed.todoIds ? new Set(parsed.todoIds) : null;
  const accountId = normalizeOptional(parsed.accountId);
  const dismissal = dismissalWrite(attribution);
  const auditReason = dismissal.auditReason;
  const statuses = parsed.statuses ?? LIVE_TODO_STATUSES;

  if (!senderEmail && !sourceThreadId) {
    return {
      ok: false,
      status: "needs_clarification",
      reason: "missing_source_or_sender",
      message:
        "I could not identify the todo source or sender to resolve. Which sender or thread should I use?",
      auditReason,
    };
  }

  const candidates = await loadLiveGmailTodoCandidates(parsed.userId, statuses, requestedTodoIds);

  const relevant = sourceThreadId
    ? candidates.filter((candidate) => candidate.threadIds.includes(sourceThreadId))
    : candidates;

  if (relevant.length === 0) return notFound(auditReason);

  const allThreadIds = [...new Set(relevant.flatMap((candidate) => candidate.threadIds))];

  const threadMetadata =
    senderEmail || accountId
      ? await loadThreadMetadata(parsed.userId, allThreadIds)
      : new Map<string, GmailThreadMetadata>();

  const todoIds = new Set<string>();
  const matchedThreadIds = new Set<string>();

  for (const candidate of relevant) {
    for (const threadId of candidate.threadIds) {
      if (sourceThreadId && threadId !== sourceThreadId) continue;

      if (senderEmail || accountId) {
        const meta = threadMetadata.get(threadId);

        if (!meta) continue;

        if (accountId && !meta.accountIds.has(accountId)) continue;

        if (senderEmail && !meta.senderEmails.has(senderEmail)) continue;
      }

      todoIds.add(candidate.id);
      matchedThreadIds.add(threadId);
    }
  }

  // Each todo keeps the status it was matched in, so a todo promoted since the read stays.
  const statusById = new Map(relevant.map((candidate) => [candidate.id, candidate.status]));

  const idsIn = (status: z.infer<typeof liveTodoStatusSchema>) =>
    [...todoIds].filter((id) => statusById.get(id) === status);

  if (todoIds.size === 0) return notFound(auditReason);

  const dismissed = await db()
    .update(todos)
    .set(dismissal.set)
    .where(
      and(
        eq(todos.userId, parsed.userId),
        or(
          ...statuses.flatMap((status) => {
            const ids = idsIn(status);

            return ids.length > 0 ? [and(eq(todos.status, status), inArray(todos.id, ids))] : [];
          }),
        ),
      ),
    )
    .returning({ id: todos.id });

  if (dismissed.length === 0) return notFound(auditReason);
  emitReplicachePokes([parsed.userId]);

  return {
    ok: true,
    status: "dismissed",
    dismissedCount: dismissed.length,
    todoIds: dismissed.map((row) => row.id),
    matchedThreadIds: [...matchedThreadIds],
    auditReason,
  };
}

const resolveTodosByIdsArgsSchema = z.object({
  userId: z.string().min(1),
  todoIds: resolveTodoIdsSchema,
});

export type ResolveTodosByIdsArgs = z.infer<typeof resolveTodosByIdsArgsSchema>;

/** Why one requested id was not dismissed. A todo of another user reads as `not_found`. */
export type ResolveTodoSkip =
  | { todoId: string; reason: "not_found" }
  | { todoId: string; reason: "not_live"; status: TodoStatus };

export interface ResolveTodosByIdsResult {
  ok: true;
  /**
   * `dismissed`: the write changed at least one todo; `skipped` lists the rest. `not_live`: it
   * changed none, and at least one id is a todo of the user that is not live. `not_found`: it
   * changed none, and no id is a todo of the user.
   */
  status: "dismissed" | "not_live" | "not_found";
  dismissedCount: number;
  todoIds: string[];
  /** Each requested id that the write did not change, with the reason. */
  skipped: ResolveTodoSkip[];
  /** The write's `note`, else its `cause`. Echoed for the model and the log. */
  auditReason: string | null;
}

/**
 * Dismiss the named todos (`system.resolve_todo`, kind `todo_ids`). The UPDATE itself applies
 * the id list, the user scope, and the live statuses, so no prior read is trusted. A read after
 * the write reports each id that the write did not change: `not_live` with the current status
 * for a todo of the user, else `not_found`. A todo that the user promoted after the caller read it
 * is still dismissed: the ADR-0116 drift guard (`row_version`) owns that case.
 */
export async function resolveTodosByIds(
  args: ResolveTodosByIdsArgs,
  attribution: TodoAttribution,
): Promise<ResolveTodosByIdsResult> {
  const parsed = resolveTodosByIdsArgsSchema.parse(args);
  const requested = [...new Set(parsed.todoIds)];
  const dismissal = dismissalWrite(attribution);

  const dismissed = await db()
    .update(todos)
    .set(dismissal.set)
    .where(
      and(
        eq(todos.userId, parsed.userId),
        inArray(todos.id, requested),
        inArray(todos.status, liveTodoStatusSchema.options),
      ),
    )
    .returning({ id: todos.id });

  const dismissedIds = new Set(dismissed.map((row) => row.id));
  const rest = requested.filter((id) => !dismissedIds.has(id));

  const current =
    rest.length > 0
      ? await db()
          .select({ id: todos.id, status: todos.status })
          .from(todos)
          .where(and(eq(todos.userId, parsed.userId), inArray(todos.id, rest)))
      : [];

  const statusById = new Map(current.map((row) => [row.id, row.status]));

  if (dismissed.length > 0) emitReplicachePokes([parsed.userId]);

  const skipped = rest.map((todoId): ResolveTodoSkip => {
    const status = statusById.get(todoId);

    return status === undefined
      ? { todoId, reason: "not_found" }
      : { todoId, reason: "not_live", status };
  });

  return {
    ok: true,
    status:
      dismissed.length > 0
        ? "dismissed"
        : skipped.some((skip) => skip.reason === "not_live")
          ? "not_live"
          : "not_found",
    dismissedCount: dismissed.length,
    todoIds: requested.filter((id) => dismissedIds.has(id)),
    skipped,
    auditReason: dismissal.auditReason,
  };
}

export function gmailThreadIdsFromTodoSources(value: unknown): string[] {
  const parsed = todoSourcesSchema.safeParse(value);

  if (!parsed.success) return [];

  return gmailThreadIdsFromSources(parsed.data);
}

export function gmailThreadIdsFromSources(sources: readonly TodoSource[]): string[] {
  const ids = new Set<string>();

  for (const source of sources) {
    if (source.provider === "gmail" && source.kind === "thread") ids.add(source.id);
  }

  return [...ids];
}

async function loadLiveGmailTodoCandidates(
  userId: string,
  statuses: ReadonlyArray<z.infer<typeof liveTodoStatusSchema>>,
  requestedTodoIds: ReadonlySet<string> | null,
): Promise<CandidateTodo[]> {
  const rows = await db()
    .select({ id: todos.id, status: todos.status, sources: todos.sources })
    .from(todos)
    .where(
      and(
        eq(todos.userId, userId),
        inArray(todos.status, [...statuses]),
        requestedTodoIds ? inArray(todos.id, [...requestedTodoIds]) : undefined,
      ),
    );

  return rows.flatMap((row) => {
    const threadIds = gmailThreadIdsFromTodoSources(row.sources);
    const status = liveTodoStatusSchema.safeParse(row.status);

    return threadIds.length > 0 && status.success
      ? [{ id: row.id, status: status.data, threadIds }]
      : [];
  });
}

async function loadThreadMetadata(
  userId: string,
  sourceThreadIds: readonly string[],
): Promise<Map<string, GmailThreadMetadata>> {
  if (sourceThreadIds.length === 0) return new Map();

  const rows = await db()
    .select({
      sourceThreadId: documents.sourceThreadId,
      accountId: documents.accountId,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        inArray(documents.sourceThreadId, [...sourceThreadIds]),
      ),
    );

  const out = new Map<string, GmailThreadMetadata>();

  for (const row of rows) {
    if (!row.sourceThreadId) continue;
    const senderEmail = metadataSenderEmail(row.metadata);

    const existing =
      out.get(row.sourceThreadId) ??
      ({
        sourceThreadId: row.sourceThreadId,
        accountIds: new Set<string | null>(),
        senderEmails: new Set<string>(),
      } satisfies GmailThreadMetadata);

    existing.accountIds.add(row.accountId);

    if (senderEmail) existing.senderEmails.add(senderEmail);
    out.set(row.sourceThreadId, existing);
  }

  return out;
}

function metadataSenderEmail(metadata: unknown): string | null {
  return normalizeEmailAddress(parseGmailDocumentMetadata(metadata).from);
}

/**
 * The ADR-0115 record of one dismissal and the column values of its UPDATE. It parses the
 * attribution and builds values only: it reads and writes nothing.
 */
function dismissalWrite(attribution: TodoAttribution) {
  const record = todoAttributionSchema.parse(attribution);
  const note = normalizeOptional(record.note);

  return {
    /** The write's `note`, else its `cause`. */
    auditReason: note ?? record.cause,
    set: {
      status: "dismissed",
      completedAt: null,
      attribution: { ...record, note },
      rowVersion: sql`${todos.rowVersion} + 1`,
    } satisfies PgUpdateSetSource<typeof todos>,
  };
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function notFound(auditReason: string | null): ResolveTodosForGmailSourceResult {
  return {
    ok: true,
    status: "not_found",
    dismissedCount: 0,
    todoIds: [],
    matchedThreadIds: [],
    auditReason,
  };
}

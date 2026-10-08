import {
  normalizeEmailAddress,
  parseGmailDocumentMetadata,
  standingInstructionTargetSchema,
  targetMatchesSender,
  targetNamesOneMailbox,
  TODO_RESOLVED_BY,
  todoSourcesSchema,
  type TodoSource,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, todos } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "@alfred/assistant/triggers";

/** Live statuses a dismissal may target. */
const liveTodoStatusSchema = z.enum(["open", "suggested"]);

const resolveTodosForGmailSourceArgsSchema = z
  .object({
    userId: z.string().min(1),
    senderEmail: z.string().nullish(),
    sourceThreadId: z.string().nullish(),
    /** Exact todo allowlist for a caller with narrower provenance. Re-applied in the UPDATE. */
    todoIds: z.array(z.string().min(1)).min(1).optional(),
    accountId: z.string().nullable().optional(),
    /**
     * Sweep the live todos whose thread matches this standing-instruction target
     * ({@link targetMatchesSender}). Never with `senderEmail`, `accountId`, `todoIds`,
     * or `statuses`: the target owns its account gate and status bound.
     */
    target: standingInstructionTargetSchema.nullish(),
    /**
         /** Audit label, persisted as `resolved_reason`. Free text, because the model supplies it. */
    reason: z.string().max(1_000).nullish(),
    /**
         /** Persisted as `resolved_by`; `todo_events` records it. `system` is the `close-loop-todos` retraction. */
    actor: z.enum(TODO_RESOLVED_BY).default("agent"),
    /**
         /**
          * Statuses to retract; defaults to both. `close-loop-todos` passes `["suggested"]`:
          * it may drop an unpromoted proposal, never a todo the user promoted to `open`.
          * Never with `target`.
          */
    statuses: z.array(liveTodoStatusSchema).min(1).optional(),
  })
  .refine((data) => data.todoIds === undefined || data.sourceThreadId != null, {
    message: "Pass todoIds only alongside sourceThreadId.",
  })
  .refine(
    (data) =>
      !(
        data.target &&
        (data.senderEmail ||
          data.accountId ||
          data.todoIds !== undefined ||
          data.statuses !== undefined)
      ),
    {
      message: "Pass target alone — never beside senderEmail, accountId, todoIds, or statuses.",
    },
  );

export type ResolveTodosForGmailSourceArgs = z.infer<typeof resolveTodosForGmailSourceArgsSchema>;

const DEFAULT_RETRACTABLE_STATUSES = ["open", "suggested"] as const satisfies ReadonlyArray<
  z.infer<typeof liveTodoStatusSchema>
>;

/**
 * A class target (such as a domain) widens the sender set, so it may retract only
 * `suggested`, never a promoted `open` todo. A one-mailbox target
 * ({@link targetNamesOneMailbox}) keeps both statuses.
 */
const TARGET_SWEEP_STATUSES = ["suggested"] as const satisfies ReadonlyArray<
  z.infer<typeof liveTodoStatusSchema>
>;

export type ResolveTodosForGmailSourceResult =
  | {
      ok: true;
      status: "dismissed" | "not_found";
      dismissedCount: number;
      todoIds: string[];
      matchedThreadIds: string[];
      /** Persisted as `resolved_reason`. */
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
  threadIds: string[];
}

interface GmailThreadMetadata {
  sourceThreadId: string;
  accountIds: Set<string | null>;
  senderEmails: Set<string>;
}

/**
 * Dismiss live Gmail-sourced todos by source: by `sourceThreadId` (`close-loop-todos`),
 * by `senderEmail`/`accountId` (`system.resolve_todo`), by `target` (`system.remember`),
 * or a thread plus one sender scope. `todoIds` can narrow a thread call further.
 * A class-target sweep is forced to `suggested` only.
 */
export async function resolveTodosForGmailSource(
  args: ResolveTodosForGmailSourceArgs,
): Promise<ResolveTodosForGmailSourceResult> {
  const parsed = resolveTodosForGmailSourceArgsSchema.parse(args);
  const senderEmail = normalizeEmailAddress(parsed.senderEmail);
  const sourceThreadId = normalizeOptional(parsed.sourceThreadId);
  const requestedTodoIds = parsed.todoIds ? new Set(parsed.todoIds) : null;
  const accountId = normalizeOptional(parsed.accountId);
  const target = parsed.target ?? null;
  const auditReason = normalizeOptional(parsed.reason);

  // Class target: `suggested` only. One-mailbox target: the caller default.
  // The schema refuses `statuses` with `target`.
  const statuses = target
    ? targetNamesOneMailbox(target)
      ? DEFAULT_RETRACTABLE_STATUSES
      : TARGET_SWEEP_STATUSES
    : (parsed.statuses ?? DEFAULT_RETRACTABLE_STATUSES);

  if (!senderEmail && !sourceThreadId && !target) {
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
    senderEmail || accountId || target
      ? await loadThreadMetadata(parsed.userId, allThreadIds)
      : new Map<string, GmailThreadMetadata>();

  const todoIds = new Set<string>();
  const matchedThreadIds = new Set<string>();

  for (const candidate of relevant) {
    for (const threadId of candidate.threadIds) {
      if (sourceThreadId && threadId !== sourceThreadId) continue;

      if (senderEmail || accountId || target) {
        const meta = threadMetadata.get(threadId);

        if (!meta) continue;

        if (target) {
          // Use the instruction's own match rule. Senders and accounts are matched as two
          // separate sets, not as pairs, so a thread across two mailboxes can over-match.
          // An unknown target kind matches nothing.
          const covered = [...meta.senderEmails].some((sender) =>
            [...meta.accountIds].some((account) => targetMatchesSender(target, sender, account)),
          );

          if (!covered) continue;
        } else {
          if (accountId && !meta.accountIds.has(accountId)) continue;

          if (senderEmail && !meta.senderEmails.has(senderEmail)) continue;
        }
      }

      todoIds.add(candidate.id);
      matchedThreadIds.add(threadId);
    }
  }

  if (todoIds.size === 0) return notFound(auditReason);

  const dismissed = await db()
    .update(todos)
    .set({
      status: "dismissed",
      completedAt: null,
      resolvedBy: parsed.actor,
      resolvedReason: auditReason,
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(
      and(
        eq(todos.userId, parsed.userId),
        inArray(todos.id, [...todoIds]),
        inArray(todos.status, [...statuses]),
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
    .select({ id: todos.id, sources: todos.sources })
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

    return threadIds.length > 0 ? [{ id: row.id, threadIds }] : [];
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

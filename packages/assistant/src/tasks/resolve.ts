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

/** The live (`not-yet-terminal`) statuses a dismissal may target. */
const liveTodoStatusSchema = z.enum(["open", "suggested"]);

const resolveTodosForGmailSourceArgsSchema = z
  .object({
    userId: z.string().min(1),
    senderEmail: z.string().nullish(),
    sourceThreadId: z.string().nullish(),
    accountId: z.string().nullable().optional(),
    /**
     * A stored standing-instruction target to sweep: dismisses the live todos
     * the sweep may retract (both live statuses for a one-mailbox target,
     * `suggested` only for a class target — see below) whose thread carries
     * pair the target covers, per {@link targetMatchesSender}. The
     * `system.remember` path passes the instruction it just wrote; the
     * thread-only and single-address callers leave this unset. Never
     * alongside `senderEmail`, `accountId`, or `statuses` — the target already
     * carries the `accountId` gate and owns its status bound (one-mailbox
     * targets keep both live statuses, class targets sweep `suggested` only),
     * so a second scope riding along is a caller bug.
     */
    target: standingInstructionTargetSchema.nullish(),
    /**
     * Audit label for why the caller is dismissing. Free text because the
     * model-authored `system.resolve_todo` path supplies it; bounded like the
     * tool input. Persisted on the row as `resolved_reason` and echoed back as
     * {@link ResolveTodosForGmailSourceResult} `auditReason` so callers can log it.
     */
    reason: z.string().max(1_000).nullish(),
    /**
     * Who is doing the dismissing. Persisted as `resolved_by` and fanned out
     * into the append-only `todo_events` history by the transition trigger —
     * this is the answer to "who cleared this?". `agent` for tool calls acting
     * for the user, `system` for the automatic `close-loop-todos` retraction.
     */
    actor: z.enum(TODO_RESOLVED_BY).default("agent"),
    /**
     * Which live statuses to retract. Defaults to both: the manual
     * `system.resolve_todo` path dismisses whatever the user pointed at,
     * promoted or not. The automatic `close-loop-todos` retraction
     * passes `["suggested"]` on purpose — it may only drop an **unpromoted**
     * proposal, never a commitment the user explicitly promoted to `open`, where
     * a holding reply ("I'll send it tomorrow") is progress, not closure.
     * Never beside `target`: the sweep owns its own bound (see below), so a
     * caller-stated scope riding along is a caller bug and the parse refuses it.
     */
    statuses: z.array(liveTodoStatusSchema).min(1).optional(),
  })
  .refine(
    (data) => !(data.target && (data.senderEmail || data.accountId || data.statuses !== undefined)),
    {
      message: "Pass target alone — never beside senderEmail, accountId, or statuses.",
    },
  );

export type ResolveTodosForGmailSourceArgs = z.infer<typeof resolveTodosForGmailSourceArgsSchema>;

/** Both live statuses; the default when a caller does not narrow. */
const DEFAULT_RETRACTABLE_STATUSES = ["open", "suggested"] as const satisfies ReadonlyArray<
  z.infer<typeof liveTodoStatusSchema>
>;

/**
 * The only status a CLASS-target sweep may retract. A domain target widens
 * the sender set, so it must not widen the status set with it: an automatic
 * retraction may drop an unpromoted `suggested` proposal, never an `open`
 * commitment the user promoted (same rule `close-loop-todos` follows at
 * `workflow-operations.ts:962-968`). A target that names ONE mailbox (see
 * {@link targetNamesOneMailbox}) widens nothing, so its sweep keeps the
 * caller default — both live statuses — preserving the `scope:"sender"`
 * behavior exactly. This is a deliberate narrowing for `scope:"domain"`:
 * on main the caller passed the named address on every path, so a domain
 * mute dismissed that one address's promoted `open` todo; at HEAD the class
 * bound governs the whole covered set, that address included, and the named
 * address's `open` todo survives.
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
      /** The caller's audit label, persisted as `resolved_reason` and echoed for logging. */
      auditReason: string | null;
    }
  | {
      ok: false;
      status: "needs_clarification";
      reason: "missing_source_or_sender";
      message: string;
      /** The caller's audit label, echoed for logging. Never persisted. */
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
 * Dismiss live Gmail-sourced todos by the source they carry, not by sender
 * alone. A caller may scope by `sourceThreadId` (the `close-loop-todos`
 * retraction, which knows only the thread), by `senderEmail`/`accountId` (the
 * `system.resolve_todo` path), by `target` (the `system.remember` path, which
 * sweeps every sender the stored instruction covers), or combine a thread
 * with one sender-scope; any one mode alone is enough. Named for the source
 * because the thread-only call is a first-class caller, not a misuse of a
 * sender-shaped API.
 *
 * The statuses to retract are a caller decision ({@link
 * ResolveTodosForGmailSourceArgs.statuses}), defaulting to both live ones. The
 * automatic retraction narrows to `suggested` so it never buries a todo the
 * user promoted — and a CLASS-target sweep is forced to the same bound below,
 * so the widened sender set cannot widen the status set with it. A
 * one-mailbox target sweep keeps the caller default (both), preserving the
 * single-address behavior that predates this item.
 */
export async function resolveTodosForGmailSource(
  args: ResolveTodosForGmailSourceArgs,
): Promise<ResolveTodosForGmailSourceResult> {
  const parsed = resolveTodosForGmailSourceArgsSchema.parse(args);
  const senderEmail = normalizeEmailAddress(parsed.senderEmail);
  const sourceThreadId = normalizeOptional(parsed.sourceThreadId);
  const accountId = normalizeOptional(parsed.accountId);
  const target = parsed.target ?? null;
  const auditReason = normalizeOptional(parsed.reason);

  // A CLASS-target sweep is an automatic retraction over a widened sender
  // set: `suggested` only. A one-mailbox target widens nothing, so its sweep
  // keeps the caller default (both live statuses). `statuses` beside `target`
  // never reaches here — the schema refuses it — so there is nothing to
  // narrow or substitute; the bound turns on the target's width alone.
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

  const candidates = await loadLiveGmailTodoCandidates(parsed.userId, statuses);

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
          // The sweep covers exactly the set the instruction's own match
          // rule covers: one function answers for the write and the sweep.
          // Each thread's senders and accounts both feed the matcher, so a
          // scoped target's `accountId` gate participates — but only as two
          // independent sets (some sender matches AND some account passes),
          // never as a real (sender, account) pair. A thread spanning two
          // mailboxes can therefore over-match a scoped target; returning
          // pairs from `loadThreadMetadata` is queued follow-up work. A
          // future target kind the sweep does not know matches nothing
          // rather than mis-matching, per `targetMatchesSender`'s
          // fail-closed arm.
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
): Promise<CandidateTodo[]> {
  const rows = await db()
    .select({ id: todos.id, sources: todos.sources })
    .from(todos)
    .where(and(eq(todos.userId, userId), inArray(todos.status, [...statuses])));

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

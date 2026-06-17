import { todoSourcesSchema, type TodoSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, todos } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { emitReplicachePokes } from "../../events/replicache-events";
import { normalizeSenderEmail } from "../memory/sender-email";

export const resolveTodosForGmailSenderArgsSchema = z.object({
  userId: z.string().min(1),
  senderEmail: z.string().nullish(),
  sourceThreadId: z.string().nullish(),
  accountId: z.string().nullable().optional(),
  reason: z.string().nullish(),
});
export type ResolveTodosForGmailSenderArgs = z.infer<typeof resolveTodosForGmailSenderArgsSchema>;

export type ResolveTodosForGmailSenderResult =
  | {
      ok: true;
      status: "dismissed" | "not_found";
      dismissedCount: number;
      todoIds: string[];
      matchedThreadIds: string[];
    }
  | {
      ok: false;
      status: "needs_clarification";
      reason: "missing_source_or_sender";
      message: string;
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

export async function resolveTodosForGmailSender(
  args: ResolveTodosForGmailSenderArgs,
): Promise<ResolveTodosForGmailSenderResult> {
  const parsed = resolveTodosForGmailSenderArgsSchema.parse(args);
  const senderEmail = normalizeSenderEmail(parsed.senderEmail);
  const sourceThreadId = normalizeOptional(parsed.sourceThreadId);
  const accountId = normalizeOptional(parsed.accountId);

  if (!senderEmail && !sourceThreadId) {
    return {
      ok: false,
      status: "needs_clarification",
      reason: "missing_source_or_sender",
      message:
        "I could not identify the todo source or sender to resolve. Which sender or thread should I use?",
    };
  }

  const candidates = await loadLiveGmailTodoCandidates(parsed.userId);
  const relevant = sourceThreadId
    ? candidates.filter((candidate) => candidate.threadIds.includes(sourceThreadId))
    : candidates;
  if (relevant.length === 0) return notFound();

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

  if (todoIds.size === 0) return notFound();

  const dismissed = await db()
    .update(todos)
    .set({
      status: "dismissed",
      completedAt: null,
      rowVersion: sql`${todos.rowVersion} + 1`,
    })
    .where(
      and(
        eq(todos.userId, parsed.userId),
        inArray(todos.id, [...todoIds]),
        inArray(todos.status, ["open", "suggested"]),
      ),
    )
    .returning({ id: todos.id });

  if (dismissed.length === 0) return notFound();
  emitReplicachePokes([parsed.userId]);

  return {
    ok: true,
    status: "dismissed",
    dismissedCount: dismissed.length,
    todoIds: dismissed.map((row) => row.id),
    matchedThreadIds: [...matchedThreadIds],
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

async function loadLiveGmailTodoCandidates(userId: string): Promise<CandidateTodo[]> {
  const rows = await db()
    .select({ id: todos.id, sources: todos.sources })
    .from(todos)
    .where(and(eq(todos.userId, userId), inArray(todos.status, ["open", "suggested"])));

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
  if (!metadata || typeof metadata !== "object" || !("from" in metadata)) return null;
  const from = (metadata as { from?: unknown }).from;
  return typeof from === "string" ? normalizeSenderEmail(from) : null;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function notFound(): ResolveTodosForGmailSenderResult {
  return {
    ok: true,
    status: "not_found",
    dismissedCount: 0,
    todoIds: [],
    matchedThreadIds: [],
  };
}

import { sanitizeVoice } from "@alfred/ai/voice";
import {
  boundTodoSources,
  mergeTodoSources,
  todoSourceKey,
  todoSourcesShareIdentityOverlap,
  type TodoSource,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { todos } from "@alfred/db/schemas";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { emitReplicachePokes } from "@alfred/assistant/triggers";

/**
 * A resolved todo blocks a re-suggestion of the same identity for this long (ADR-0050, #139).
 * A shared Gmail `thread` alone does not count ({@link todoSourcesShareIdentityOverlap}).
 */
const RESUGGEST_SUPPRESSION_WINDOW_DAYS = 30;

export interface SuggestTodoInput {
  userId: string;
  agentRunId: string;
  name: string;
  description?: string | undefined;
  /** An honest "I can't act on this" is fine. */
  assist?: string | undefined;
  /** Drives the merge guard. */
  sources?: TodoSource[] | undefined;
}

export type SuggestTodoResult =
  | { ok: true; status: "created"; todoId: string }
  | { ok: true; status: "merged"; todoId: string; addedSources: number }
  | { ok: true; status: "suppressed"; todoId: string; reason: "done" | "dismissed" };

/** True when any source matches by `(provider, kind, id)`; `url` is not identity. The guard {@link suggestTodo} runs. */
export function todoSourcesOverlap(existing: TodoSource[], incoming: TodoSource[]): boolean {
  if (existing.length === 0 || incoming.length === 0) return false;
  const incomingKeys = new Set(incoming.map(todoSourceKey));

  return existing.some((ref) => incomingKeys.has(todoSourceKey(ref)));
}

/**
 * Insert a `suggested` todo for an agent run (ADR-0050). No approval: it has no side effect.
 * If a live todo shares a source, merge the new refs into it instead.
 * If only a recently resolved todo shares an identity ref, suppress (#139).
 * A shared Gmail `thread` is not identity: one thread can carry many asks.
 * A live overlap beats a resolved one.
 */
export async function suggestTodo(input: SuggestTodoInput): Promise<SuggestTodoResult> {
  // Sanitize once here, so triage and the tool both get it.
  const name = sanitizeVoice(input.name.trim()).trim();
  const rawAssist = input.assist?.trim() ?? "";
  const assist = rawAssist ? sanitizeVoice(rawAssist).trim() : "";
  const normalizedAssist = assist.length > 0 ? assist : undefined;

  // Bound now so neither insert nor merge passes the sync schema max (#355).
  const sources = boundTodoSources(input.sources ?? []);

  const result = await db().transaction(async (tx) => {
    // Load candidates and match in JS; fine at single-user scale.
    if (sources.length > 0) {
      const lockKey = `todo:suggest:${input.userId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const resolvedCutoff = new Date(
        Date.now() - RESUGGEST_SUPPRESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );

      const candidates = await tx
        .select({ id: todos.id, status: todos.status, sources: todos.sources })
        .from(todos)
        .where(
          and(
            eq(todos.userId, input.userId),
            or(
              inArray(todos.status, ["open", "suggested"]),
              // Recently resolved rows too, so handled work is not re-suggested.
              and(
                inArray(todos.status, ["done", "dismissed"]),
                gte(todos.updatedAt, resolvedCutoff),
              ),
            ),
          ),
        );

      // Live overlap first: an open item should take the new ref.
      const overlapping = candidates.filter((c) => todoSourcesOverlap(c.sources ?? [], sources));
      const live = overlapping.filter((c) => c.status === "open" || c.status === "suggested");

      const resolved = overlapping.filter(
        (c): c is typeof c & { status: "done" | "dismissed" } =>
          (c.status === "done" || c.status === "dismissed") &&
          // Identity only: the same thread may carry a new ask the user has not seen.
          todoSourcesShareIdentityOverlap(c.sources ?? [], sources),
      );

      const liveMatch = live[0];

      if (liveMatch) {
        const existing = liveMatch.sources ?? [];
        const existingKeys = new Set(existing.map(todoSourceKey));
        // A recurring loop merges here and adds a `thread` ref each time; bound it (#355).
        const merged = boundTodoSources(mergeTodoSources(existing, sources));
        const addedSources = merged.filter((ref) => !existingKeys.has(todoSourceKey(ref))).length;

        // Bounding can swap an old thread for the newest at the same length, so compare content.
        const changed =
          merged.length !== existing.length ||
          merged.some((ref) => !existingKeys.has(todoSourceKey(ref)));

        if (changed) {
          await tx
            .update(todos)
            .set({ sources: merged, rowVersion: sql`${todos.rowVersion} + 1` })
            .where(eq(todos.id, liveMatch.id));
        }

        return { status: "merged" as const, todoId: liveMatch.id, addedSources };
      }

      const resolvedMatch = resolved[0];

      if (resolvedMatch) {
        return {
          status: "suppressed" as const,
          todoId: resolvedMatch.id,
          reason: resolvedMatch.status,
        };
      }
    }

    const [row] = await tx
      .insert(todos)
      .values({
        userId: input.userId,
        name,
        description: input.description ?? null,
        status: "suggested",
        createdBy: "agent",
        assist: normalizedAssist ?? null,
        sources,
        agentRunId: input.agentRunId,
      })
      .returning({ id: todos.id });

    if (!row) {
      throw new Error("[suggestTodo] insert returned no row");
    }

    return { status: "created" as const, todoId: row.id };
  });

  // Poke after commit. A suppression wrote nothing.
  if (result.status !== "suppressed") emitReplicachePokes([input.userId]);

  switch (result.status) {
    case "merged":
      return {
        ok: true,
        status: "merged",
        todoId: result.todoId,
        addedSources: result.addedSources,
      };
    case "suppressed":
      return { ok: true, status: "suppressed", todoId: result.todoId, reason: result.reason };
    case "created":
      return { ok: true, status: "created", todoId: result.todoId };
    default: {
      const _exhaustive: never = result;
      throw new Error(`[suggestTodo] unhandled result: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

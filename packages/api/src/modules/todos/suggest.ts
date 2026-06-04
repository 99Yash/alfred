import { mergeTodoSources, todoSourceKey, type TodoSource } from "@alfred/contracts";
import { db } from "@alfred/db";
import { todos } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";
import { emitReplicachePokes } from "../../events/replicache-events";

export interface SuggestTodoInput {
  userId: string;
  /** Agent run that proposed this todo (traceability). */
  agentRunId: string;
  name: string;
  description?: string;
  /** Optional Alfred-authored tip; an honest "I can't act on this" when clueless. */
  assist?: string;
  /** Cross-source provenance refs. Drives the idempotency/merge guard. */
  sources?: TodoSource[];
}

export type SuggestTodoResult =
  | { ok: true; status: "created"; todoId: string }
  | { ok: true; status: "merged"; todoId: string; addedSources: number };

/**
 * Insert a `suggested` todo on behalf of an agent run (ADR-0050). The source-
 * agnostic write path for `system.suggest_todo`.
 *
 * **No HIL**: a suggestion has no real-world side effect, so it stays off the
 * `action_stagings` / approvals path; audit lives on the row (`agent_run_id`,
 * `created_by='agent'`, lifecycle dates).
 *
 * **Idempotent on source overlap**: if a live (`open`/`suggested`) todo already
 * references any incoming `(provider, kind, id)`, we merge the missing refs
 * into that row instead of creating a duplicate. This is the v1 cross-channel
 * dedup guard — the *structural* case (recognizable, shares an id). Semantic
 * dedup of independent same-topic signals is deferred.
 */
export async function suggestTodo(input: SuggestTodoInput): Promise<SuggestTodoResult> {
  const sources = input.sources ?? [];

  const result = await db().transaction(async (tx) => {
    // Dedup against live todos that carry at least one source. Single-user
    // scale — load candidates and resolve overlap in JS rather than a jsonb
    // containment query per incoming ref.
    if (sources.length > 0) {
      const lockKey = `todo:suggest:${input.userId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const incomingKeys = new Set(sources.map(todoSourceKey));
      const candidates = await tx
        .select({ id: todos.id, sources: todos.sources })
        .from(todos)
        .where(and(eq(todos.userId, input.userId), inArray(todos.status, ["open", "suggested"])));

      for (const candidate of candidates) {
        const existing = candidate.sources ?? [];
        if (!existing.some((ref) => incomingKeys.has(todoSourceKey(ref)))) continue;

        const merged = mergeTodoSources(existing, sources);
        const addedSources = merged.length - existing.length;
        if (addedSources > 0) {
          await tx
            .update(todos)
            .set({ sources: merged, rowVersion: sql`${todos.rowVersion} + 1` })
            .where(eq(todos.id, candidate.id));
        }
        return { status: "merged" as const, todoId: candidate.id, addedSources };
      }
    }

    const [row] = await tx
      .insert(todos)
      .values({
        userId: input.userId,
        name: input.name,
        description: input.description ?? null,
        status: "suggested",
        createdBy: "agent",
        assist: input.assist ?? null,
        sources,
        agentRunId: input.agentRunId,
      })
      .returning({ id: todos.id });

    return { status: "created" as const, todoId: row!.id };
  });

  // Poke AFTER commit so the client's pull sees the write (events contract).
  emitReplicachePokes([input.userId]);

  return result.status === "merged"
    ? { ok: true, status: "merged", todoId: result.todoId, addedSources: result.addedSources }
    : { ok: true, status: "created", todoId: result.todoId };
}

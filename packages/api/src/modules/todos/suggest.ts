import {
  boundTodoSources,
  mergeTodoSources,
  todoSourceKey,
  type TodoSource,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { todos } from "@alfred/db/schemas";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { emitReplicachePokes } from "../../events/replicache-events";

/**
 * How far back a resolved (`done`/`dismissed`) todo still suppresses a
 * re-suggestion of the same source. Bounds the dedup scan and means a signal
 * the user acted on once won't be re-proposed for a month. Generous on purpose
 * — re-suggesting closed work is high-friction (ADR-0050; #139).
 */
const RESUGGEST_SUPPRESSION_WINDOW_DAYS = 30;

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
  | { ok: true; status: "merged"; todoId: string; addedSources: number }
  | { ok: true; status: "suppressed"; todoId: string; reason: "done" | "dismissed" };

/**
 * Structural dedup predicate: does a candidate todo's existing sources overlap
 * the incoming set by identity `(provider, kind, id)`? This is the exact guard
 * {@link suggestTodo}'s merge loop runs — exported and pure so it can be tested
 * directly (the DB transaction has no test harness), instead of a re-implemented
 * copy drifting from the real path. `url` is not part of identity.
 */
export function todoSourcesOverlap(existing: TodoSource[], incoming: TodoSource[]): boolean {
  if (existing.length === 0 || incoming.length === 0) return false;
  const incomingKeys = new Set(incoming.map(todoSourceKey));
  return existing.some((ref) => incomingKeys.has(todoSourceKey(ref)));
}

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
 *
 * **No re-suggesting resolved work**: if the only overlap is a recently
 * `done`/`dismissed` todo (the user already acted on or rejected this exact
 * source), we suppress rather than mint a fresh suggestion — re-proposing
 * closed work trains the user to distrust the rail (#139). A live overlap
 * always wins over a resolved one (merge beats suppress).
 */
export async function suggestTodo(input: SuggestTodoInput): Promise<SuggestTodoResult> {
  // Bound the incoming set so neither a fresh insert nor a merge can push the
  // row past the schema max the sync read path enforces (#355).
  const sources = boundTodoSources(input.sources ?? []);

  const result = await db().transaction(async (tx) => {
    // Dedup against live todos that carry at least one source. Single-user
    // scale — load candidates and resolve overlap in JS rather than a jsonb
    // containment query per incoming ref.
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
              // Recently-resolved rows are dedup candidates too, so the same
              // source isn't re-suggested after the user already handled it.
              and(
                inArray(todos.status, ["done", "dismissed"]),
                gte(todos.updatedAt, resolvedCutoff),
              ),
            ),
          ),
        );

      // Prefer a live overlap (merge) over a resolved one (suppress): a still-
      // open item should accrue the new ref rather than be shadowed by a
      // closed duplicate. So scan live candidates first.
      const overlapping = candidates.filter((c) => todoSourcesOverlap(c.sources ?? [], sources));
      const live = overlapping.filter((c) => c.status === "open" || c.status === "suggested");
      const resolved = overlapping.filter(
        (c): c is typeof c & { status: "done" | "dismissed" } =>
          c.status === "done" || c.status === "dismissed",
      );

      const liveMatch = live[0];
      if (liveMatch) {
        const existing = liveMatch.sources ?? [];
        const existingKeys = new Set(existing.map(todoSourceKey));
        // Bound after merge: a high-frequency recurring loop merges onto this
        // row via its `loop` ref, so the set would otherwise grow a fresh gmail
        // `thread` ref per re-notification and eventually break sync (#355).
        const merged = boundTodoSources(mergeTodoSources(existing, sources));
        const addedSources = merged.filter((ref) => !existingKeys.has(todoSourceKey(ref))).length;
        // Persist on ANY content change, not just growth: bounding can evict an
        // old thread while adding the newest one (length unchanged), and that
        // newest ref is what the reverse auto-dismiss linkage needs.
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
        name: input.name,
        description: input.description ?? null,
        status: "suggested",
        createdBy: "agent",
        assist: input.assist ?? null,
        sources,
        agentRunId: input.agentRunId,
      })
      .returning({ id: todos.id });

    if (!row) {
      throw new Error("[suggestTodo] insert returned no row");
    }
    return { status: "created" as const, todoId: row.id };
  });

  // Poke AFTER commit so the client's pull sees the write (events contract).
  // A suppressed suggestion wrote nothing, so there's nothing new to sync.
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

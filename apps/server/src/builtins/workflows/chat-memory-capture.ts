import {
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  extractPropositionsFromThread,
  type ThreadTurn,
  type Workflow,
} from "@alfred/api";
import { chatPropositionSchema, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages, chatThreads } from "@alfred/db/schemas";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

/**
 * End-of-thread chat → memory capture (chat-memory-capture-v1.md, #398;
 * decisions D6/D9). Triggered by the per-thread idle debounce
 * (`chat-memory` queue) once a conversation has gone quiet.
 *
 * Steps:
 *   1. load-transcript — read the thread's finished turns (role + content, D9).
 *   2. extract         — cheap-model pass → crisp, tagged propositions (D6),
 *                        or injected proposals in manual/test mode.
 *   3. finalize        — record the tally + return the propositions as the run
 *                        output.
 *
 * SCOPE (#398): this slice does NOT write anything durable. The propositions it
 * produces are the input to #399, which will route them through
 * `insertObservation`. See the TODO(#399) in `finalize`.
 *
 * Mirrors `memory-extraction.ts`: the LLM lives in a pure extractor
 * (`@alfred/api` `extractPropositionsFromThread`) so manual mode can inject
 * proposals without the AI SDK, and a single `process`-style shape keeps the
 * executor's `(runId, stepId, attempt)` key happy.
 */

const threadTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const stateSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  threadId: z.string().min(1),
  /** Injected transcript (manual mode) — bypasses the DB read. */
  manualTranscript: z.array(threadTurnSchema).optional(),
  /** Injected propositions (manual mode) — bypasses the LLM. */
  manualPropositions: z.array(chatPropositionSchema).optional(),
  /** Populated by load-transcript. */
  transcript: z.array(threadTurnSchema),
  /** Populated by extract. */
  propositions: z.array(chatPropositionSchema),
  /** ISO timestamp captured at run-create. */
  startedAt: z.string(),
});
type State = z.infer<typeof stateSchema>;

const inputSchema = z.object({
  mode: z.enum(["auto", "manual"]).default("auto"),
  manualTranscript: z.array(threadTurnSchema).optional(),
  manualPropositions: z.array(chatPropositionSchema).optional(),
});

export const chatMemoryCaptureWorkflow: Workflow<State> = {
  slug: CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  name: "Chat memory capture",
  description:
    "End-of-thread extraction of crisp, tagged propositions from an idle chat thread (chat-mem v1, #398).",
  // Dispatched by the per-thread idle-debounce queue (chat-memory), not the
  // generic cron/event tick — declared manual like the chat-turn workflow.
  trigger: { kind: "manual" },
  initialStep: "load-transcript",
  stateSchema,

  initialState(input) {
    const metadata = input.metadata ?? {};
    const threadId = typeof metadata.threadId === "string" ? metadata.threadId : null;
    if (!threadId) throw new Error("chat-memory-capture workflow requires metadata.threadId");
    const parsed = inputSchema.parse(input.input ?? {});
    return {
      mode: parsed.mode,
      threadId,
      manualTranscript: parsed.manualTranscript,
      manualPropositions: parsed.manualPropositions,
      transcript: [],
      propositions: [],
      startedAt: new Date().toISOString(),
    };
  },

  // One capture per thread at a time. A second debounce fire that overlaps a
  // still-running capture collides on the partial unique index instead of
  // double-extracting the same thread. Failed/cancelled runs are excluded, so a
  // transient failure stays retryable.
  dedupKey(input) {
    const threadId = input.metadata?.threadId;
    return typeof threadId === "string" && threadId.length > 0
      ? `chat-memory:${threadId}`
      : null;
  },

  steps: {
    "load-transcript": {
      id: "load-transcript",
      async run(ctx) {
        // Manual mode: the test supplies the transcript, skip the DB read.
        if (ctx.state.mode === "manual" && ctx.state.manualTranscript) {
          const transcript = ctx.state.manualTranscript;
          await ctx.log(`load-transcript (manual): ${transcript.length} turn(s)`);
          return {
            kind: "next",
            state: { ...ctx.state, transcript },
            nextStep: "extract",
          };
        }

        // Guard: the thread must be the run owner's. A run is minted per user by
        // the debounce worker, but re-assert ownership before reading content.
        const [thread] = await db()
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(and(eq(chatThreads.id, ctx.state.threadId), eq(chatThreads.userId, ctx.userId)))
          .limit(1);
        if (!thread) {
          await ctx.log(`load-transcript: thread ${ctx.state.threadId} not found for user`);
          return { kind: "next", state: { ...ctx.state, transcript: [] }, nextStep: "extract" };
        }

        const rows = await db()
          .select({ role: chatMessages.role, content: chatMessages.content })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.userId, ctx.userId),
              eq(chatMessages.threadId, ctx.state.threadId),
              eq(chatMessages.status, "complete"),
            ),
          )
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
        const transcript: ThreadTurn[] = rows.map((r) => ({ role: r.role, content: r.content }));

        await ctx.log(`load-transcript: ${transcript.length} turn(s)`);
        return {
          kind: "next",
          state: { ...ctx.state, transcript },
          nextStep: "extract",
        };
      },
    },

    extract: {
      id: "extract",
      // A single cheap-model call — give it a wider stale-lease window than the
      // 60s default so a brief heartbeat lapse can't reclaim a live call.
      staleAfterMs: 120_000,
      async run(ctx) {
        // Manual mode: inject proposals, bypass the LLM (test fixtures).
        if (ctx.state.mode === "manual" && ctx.state.manualPropositions) {
          return {
            kind: "next",
            state: { ...ctx.state, propositions: ctx.state.manualPropositions },
            nextStep: "finalize",
          };
        }

        if (ctx.state.transcript.length === 0) {
          return { kind: "next", state: { ...ctx.state, propositions: [] }, nextStep: "finalize" };
        }

        try {
          const propositions = await extractPropositionsFromThread({
            userId: ctx.userId,
            threadId: ctx.state.threadId,
            transcript: ctx.state.transcript,
            runId: ctx.runId,
            stepId: "extract",
            idempotencyKey: `${ctx.idempotencyKey}:${ctx.state.threadId}`,
          });
          return {
            kind: "next",
            state: { ...ctx.state, propositions },
            nextStep: "finalize",
          };
        } catch (err) {
          // A model blip must not fail the run — capture is best-effort. Land
          // zero propositions and finish cleanly (the thread stays eligible for
          // a later capture once new turns re-arm the debounce).
          await ctx.log(`extract failed for thread=${ctx.state.threadId}: ${toMessage(err)}`);
          return { kind: "next", state: { ...ctx.state, propositions: [] }, nextStep: "finalize" };
        }
      },
    },

    finalize: {
      id: "finalize",
      async run(ctx) {
        const { propositions, threadId, transcript } = ctx.state;
        await ctx.log(
          `finalize: thread=${threadId} turns=${transcript.length} propositions=${propositions.length}`,
        );

        // TODO(#399): write these propositions into the ADR-0067 observation log
        // via `insertObservation` (mapping `attribution` → source/kind). #398 is
        // trigger + extractor only — no durable writes. For now the propositions
        // are surfaced solely as the run output, so the loop is observable end
        // to end and #399 can build directly on this shape.
        return {
          kind: "done",
          state: ctx.state,
          output: {
            threadId,
            turns: transcript.length,
            propositionCount: propositions.length,
            propositions,
          },
        };
      },
    },
  },
};

export type ChatMemoryCaptureInput = z.infer<typeof inputSchema>;

import {
  buildThreadTranscript,
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  extractPropositionsFromThread,
  type ThreadTurn,
  type Workflow,
} from "@alfred/api/backend";
import { chatPropositionSchema, isNonEmptyString, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { chatMessages, chatThreads } from "@alfred/db/schemas";
import { and, asc, eq, lt, lte, or } from "drizzle-orm";
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
  captureAfterMessageId: z.string().min(1),
  /** Injected transcript (manual mode) — bypasses the DB read. */
  manualTranscript: z.array(threadTurnSchema).optional(),
  /** Injected propositions (manual mode) — bypasses the LLM. */
  manualPropositions: z.array(chatPropositionSchema).optional(),
  /** Populated by load-transcript. */
  transcriptText: z.string(),
  /** Populated by load-transcript. */
  turnCount: z.number().int().nonnegative(),
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
    if (!isNonEmptyString(metadata.threadId)) {
      throw new Error("chat-memory-capture workflow requires metadata.threadId");
    }
    const threadId = metadata.threadId;
    if (!isNonEmptyString(metadata.captureAfterMessageId)) {
      throw new Error("chat-memory-capture workflow requires metadata.captureAfterMessageId");
    }
    const captureAfterMessageId = metadata.captureAfterMessageId;
    const parsed = inputSchema.parse(input.input ?? {});
    return {
      mode: parsed.mode,
      threadId,
      captureAfterMessageId,
      manualTranscript: parsed.manualTranscript,
      manualPropositions: parsed.manualPropositions,
      transcriptText: "",
      turnCount: 0,
      propositions: [],
      startedAt: new Date().toISOString(),
    };
  },

  // One capture per settled transcript anchor at a time. The anchor is the
  // completed assistant message that armed the debounce: duplicates for that
  // exact settled turn collide, while a later turn in the same thread can still
  // produce a fresh capture.
  dedupKey(input) {
    const threadId = input.metadata?.threadId;
    const captureAfterMessageId = input.metadata?.captureAfterMessageId;
    return isNonEmptyString(threadId) && isNonEmptyString(captureAfterMessageId)
      ? `chat-memory:${threadId}:${captureAfterMessageId}`
      : null;
  },

  steps: {
    "load-transcript": {
      id: "load-transcript",
      async run(ctx) {
        // Manual mode: the test supplies the transcript, skip the DB read.
        if (ctx.state.mode === "manual" && ctx.state.manualTranscript) {
          const transcript = ctx.state.manualTranscript;
          const transcriptText = buildThreadTranscript(transcript);
          await ctx.log(`load-transcript (manual): ${transcript.length} turn(s)`);
          return {
            kind: "next",
            state: { ...ctx.state, transcriptText, turnCount: transcript.length },
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
          return {
            kind: "next",
            state: { ...ctx.state, transcriptText: "", turnCount: 0 },
            nextStep: "extract",
          };
        }

        const [anchor] = await db()
          .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.id, ctx.state.captureAfterMessageId),
              eq(chatMessages.userId, ctx.userId),
              eq(chatMessages.threadId, ctx.state.threadId),
              eq(chatMessages.status, "complete"),
            ),
          )
          .limit(1);
        if (!anchor) {
          await ctx.log(
            `load-transcript: capture anchor ${ctx.state.captureAfterMessageId} not found for thread=${ctx.state.threadId}`,
          );
          return {
            kind: "next",
            state: { ...ctx.state, transcriptText: "", turnCount: 0 },
            nextStep: "extract",
          };
        }

        const rows = await db()
          .select({ role: chatMessages.role, content: chatMessages.content })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.userId, ctx.userId),
              eq(chatMessages.threadId, ctx.state.threadId),
              eq(chatMessages.status, "complete"),
              or(
                lt(chatMessages.createdAt, anchor.createdAt),
                and(
                  eq(chatMessages.createdAt, anchor.createdAt),
                  lte(chatMessages.id, ctx.state.captureAfterMessageId),
                ),
              ),
            ),
          )
          .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
        const transcript: ThreadTurn[] = rows.map((r) => ({ role: r.role, content: r.content }));
        const transcriptText = buildThreadTranscript(transcript);

        await ctx.log(`load-transcript: ${transcript.length} turn(s)`);
        return {
          kind: "next",
          state: { ...ctx.state, transcriptText, turnCount: transcript.length },
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

        if (ctx.state.transcriptText.trim().length === 0) {
          return { kind: "next", state: { ...ctx.state, propositions: [] }, nextStep: "finalize" };
        }

        try {
          const propositions = await extractPropositionsFromThread({
            userId: ctx.userId,
            threadId: ctx.state.threadId,
            transcript: ctx.state.transcriptText,
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
        const { propositions, threadId, turnCount } = ctx.state;
        await ctx.log(
          `finalize: thread=${threadId} turns=${turnCount} propositions=${propositions.length}`,
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
            turns: turnCount,
            propositionCount: propositions.length,
            propositions,
          },
        };
      },
    },
  },
};

export type ChatMemoryCaptureInput = z.infer<typeof inputSchema>;

import {
  COLD_START_WORKFLOW_SLUG,
  coldStartWorkflowInputSchema,
  collectColdStartSignals,
  extractColdStartFacts,
  hasPriorColdStartRun,
  proposeFact,
  researchUser,
  writeMemoryChunk,
  type ColdStartProposal,
  type ColdStartSignals,
  type ResearchResult,
  type Workflow,
} from "@alfred/api";
import { z } from "zod";

/**
 * Cold-start research workflow (ADR-0011 + ADR-0022).
 *
 * Steps:
 *   1. gather-signals — read user row + connected integrations into a
 *                       structured signal bundle.
 *   2. research       — one Sonar Deep Research call. 30–90s; Sonar
 *                       owns the multi-step search internally.
 *   3. extract-facts  — cheap-tier model converts research prose into
 *                       structured `user_facts` proposals.
 *   4. persist        — propose each fact (auto-confirm gated by the
 *                       0.85 threshold) and store the research as a
 *                       `memory_chunks` row for later semantic recall.
 *
 * Idempotency:
 *   - Trigger-side dedup (`hasPriorColdStartRun`) gates *enqueueing* a
 *     second run for the same user.
 *   - Step-side: `proposeFact` already short-circuits on the rejection
 *     guard + active-dup guard, and `writeMemoryChunk` upserts on
 *     `(user_id, kind, content_hash)`. So an in-step retry after a
 *     worker crash never double-writes.
 *
 * Latency budget:
 *   - Sonar Deep Research is the dominant cost. Tagged `kind=web_search`
 *     so cost rollups bucket it apart from the boss/sub-agent LLM line.
 *   - Total wall time per run ~30–120s. Worker heartbeat keeps the lease
 *     alive while step 2 is in flight.
 */

const stateSchema = z.object({
  reason: z.enum(["signup", "manual"]),
  force: z.boolean(),
  /** Computed in step 1; threaded through the rest of the run. */
  signals: z
    .object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      emailDomain: z.string().nullable(),
      emailDomainIsConsumer: z.boolean(),
      integrations: z.object({
        google: z.object({ accountEmail: z.string() }).optional(),
      }),
    })
    .optional(),
  /** Computed in step 2; consumed by step 3 and persisted in step 4. */
  research: z
    .object({
      content: z.string(),
      citations: z.array(z.string()),
      meta: z.object({
        finishReason: z.string(),
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      }),
    })
    .optional(),
  /** Computed in step 3; consumed in step 4. */
  proposals: z
    .array(
      z.object({
        key: z.string(),
        value: z.unknown(),
        confidence: z.number(),
        rationale: z.string(),
      }),
    )
    .optional(),
});
type State = z.infer<typeof stateSchema>;

export const coldStartResearchWorkflow: Workflow<State> = {
  slug: COLD_START_WORKFLOW_SLUG,
  description:
    "Cold-start research at signup — Sonar Deep Research → cheap-tier extract → user_facts proposals + memory_chunks (ADR-0011 + ADR-0022).",
  initialStep: "gather-signals",
  stateSchema,

  initialState(input) {
    const parsed = coldStartWorkflowInputSchema.parse(input.input ?? {});
    return { reason: parsed.reason, force: parsed.force };
  },

  steps: {
    "gather-signals": {
      id: "gather-signals",
      async run(ctx) {
        // In-workflow dedup gate. The trigger-side check in google-routes
        // already short-circuits the common case, but `/api/agent/runs`
        // accepts any registered slug from any authenticated user — so
        // without this gate, a user could re-trigger an expensive Sonar
        // call on demand. `force: true` (smoke script, future re-research
        // button) bypasses; the OAuth callback always passes `force: false`.
        if (!ctx.state.force) {
          const hasPrior = await hasPriorColdStartRun(ctx.userId, {
            excludeRunId: ctx.runId,
          });
          if (hasPrior) {
            await ctx.log(
              "gather-signals: prior cold-start run exists; skipping (no force)",
            );
            return {
              kind: "done",
              state: ctx.state,
              output: { skipped: "prior-run-exists" },
            };
          }
        }

        const signals = await collectColdStartSignals(ctx.userId);
        await ctx.log(
          `gather-signals: name="${signals.name}" domain=${signals.emailDomain ?? "n/a"}${
            signals.emailDomainIsConsumer ? " (consumer)" : ""
          } google=${signals.integrations.google ? "yes" : "no"}`,
        );
        return {
          kind: "next",
          state: { ...ctx.state, signals: signals as ColdStartSignals },
          nextStep: "research",
        };
      },
    },

    research: {
      id: "research",
      async run(ctx) {
        if (!ctx.state.signals) {
          throw new Error("[cold-start] research entered without signals");
        }
        const result: ResearchResult = await researchUser({
          signals: ctx.state.signals,
          runId: ctx.runId,
          stepId: "research",
          idempotencyKey: ctx.idempotencyKey,
        });
        await ctx.log(
          `research: finishReason=${result.meta.finishReason} chars=${result.content.length} citations=${result.citations.length}`,
        );
        return {
          kind: "next",
          state: { ...ctx.state, research: result },
          nextStep: "extract-facts",
        };
      },
    },

    "extract-facts": {
      id: "extract-facts",
      async run(ctx) {
        if (!ctx.state.signals || !ctx.state.research) {
          throw new Error("[cold-start] extract-facts entered without signals/research");
        }
        const proposals: ColdStartProposal[] = await extractColdStartFacts({
          signals: ctx.state.signals,
          research: {
            content: ctx.state.research.content,
            citations: ctx.state.research.citations,
          },
          runId: ctx.runId,
          stepId: "extract-facts",
          idempotencyKey: ctx.idempotencyKey,
        });
        await ctx.log(`extract-facts: proposals=${proposals.length}`);
        return {
          kind: "next",
          state: { ...ctx.state, proposals },
          nextStep: "persist",
        };
      },
    },

    persist: {
      id: "persist",
      async run(ctx) {
        if (!ctx.state.research || !ctx.state.proposals) {
          throw new Error("[cold-start] persist entered without research/proposals");
        }

        let inserted = 0;
        let skipped = 0;
        for (const p of ctx.state.proposals) {
          const fact = await proposeFact({
            userId: ctx.userId,
            key: p.key,
            value: p.value,
            confidence: p.confidence,
            source: {
              kind: "cold_start",
              id: ctx.runId,
              meta: {
                rationale: p.rationale,
                citations: ctx.state.research.citations,
              },
            },
          });
          if (fact) inserted++;
          else skipped++;
        }

        const chunk = await writeMemoryChunk({
          userId: ctx.userId,
          kind: "cold_start_research",
          content: ctx.state.research.content,
          source: {
            kind: "cold_start",
            id: ctx.runId,
            meta: { citations: ctx.state.research.citations },
          },
          metadata: {
            finishReason: ctx.state.research.meta.finishReason,
            inputTokens: ctx.state.research.meta.inputTokens,
            outputTokens: ctx.state.research.meta.outputTokens,
            citationCount: ctx.state.research.citations.length,
          },
        });

        await ctx.log(
          `persist: facts=${inserted}/${ctx.state.proposals.length} (skipped=${skipped}) memoryChunkId=${chunk.id}`,
        );

        return {
          kind: "done",
          state: ctx.state,
          output: {
            factsProposed: inserted,
            factsSkipped: skipped,
            memoryChunkId: chunk.id,
            citationCount: ctx.state.research.citations.length,
          },
        };
      },
    },
  },
};

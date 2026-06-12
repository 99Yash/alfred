import {
  COLD_START_DEDUP_KEY,
  COLD_START_WORKFLOW_SLUG,
  coldStartWorkflowInputSchema,
  collectColdStartSignals,
  extractColdStartFacts,
  proposeFact,
  researchAspects,
  resolveIdentity,
  synthesizeColdStart,
  writeMemoryChunk,
  type AspectFinding,
  type ColdStartProposal,
  type ColdStartSignals,
  type IdentityAnchor,
  type ResearchResult,
  type Workflow,
} from "@alfred/api";
import { z } from "zod";

/**
 * Cold-start research workflow (ADR-0011 + ADR-0022, v2 amendment).
 *
 * v2 swaps the single Perplexity Sonar Deep Research call for the agent
 * harness, run bounded inside this deterministic onboarding workflow:
 *   1. gather-signals   — read user row + connected integrations into a
 *                         structured signal bundle.
 *   2. seed             — boss identity resolution: one bounded web pass
 *                         pins the canonical public profile so every aspect
 *                         researches the same person.
 *   3. research-aspects — bounded parallel sub-agents, one per facet
 *                         (professional / employer / online / personal),
 *                         each looping a local `web_search` tool (see
 *                         `cold-start/web-tool.ts`, same grounded path as
 *                         `system.web_search`) for ~500w of findings.
 *   4. synthesis        — boss folds the findings into one ~300w telegraphic
 *                         summary (the memory chunk + extractor input).
 *   5. extract-facts    — cheap-tier model converts the summary into
 *                         structured `user_facts` proposals (unchanged).
 *   6. persist          — propose each fact (auto-confirm gated by the 0.85
 *                         threshold) and store the summary as a
 *                         `memory_chunks` row for later semantic recall.
 *
 * v2.0 is web-only: new users default to `gated`, so live Gmail/Calendar
 * reads would park in a watcher-less onboarding run. Read-only
 * calendar/gmail aspects are a v2.1 follow-up gated on the run-scoped
 * autonomy override.
 *
 * Idempotency:
 *   - Trigger-side: the workflow declares `dedupKey: () => 'cold-start'`,
 *     so the partial unique index on `agent_runs(user_id, workflow_slug,
 *     dedup_key) WHERE dedup_key IS NOT NULL AND status NOT IN
 *     ('failed', 'cancelled')` makes any second `createRun` for the same
 *     user fail with `23505`. There is no in-workflow "skip if prior
 *     run exists" gate — concurrent inserts are blocked at the DB.
 *   - Step-side: `proposeFact` already short-circuits on the rejection
 *     guard + active-dup guard, and `writeMemoryChunk` upserts on
 *     `(user_id, kind, content_hash)`. So an in-step retry after a
 *     worker crash never double-writes.
 *   - Cost: each step checkpoints its result, so a worker crash re-runs
 *     only the failed step. A crash mid-seed/aspects/synthesis re-bills
 *     just that step's LLM + web_search calls — cheap, no checkpoint
 *     cache warranted.
 *
 * Latency budget:
 *   - The aspect sub-agents run concurrently, so step 3's wall time is the
 *     slowest single aspect, not their sum. Each web_search lands its own
 *     `kind=web_search` log row; each reasoning turn a `kind=llm` row.
 *   - Worker heartbeat keeps the lease alive while a step's loop is in
 *     flight.
 */

const aspectFindingSchema = z.object({
  id: z.string(),
  label: z.string(),
  finding: z.string(),
  citations: z.array(z.string()),
});

const stateSchema = z.object({
  reason: z.enum(["signup", "manual"]),
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
  /** Computed in step 2; threaded into aspect briefs + synthesis. */
  identity: z
    .object({
      anchor: z.string(),
      confident: z.boolean(),
      citations: z.array(z.string()),
    })
    .optional(),
  /** Computed in step 3; consumed by synthesis. */
  aspects: z.array(aspectFindingSchema).optional(),
  /** Computed in step 4; consumed by step 5 and persisted in step 6. */
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
  /** Computed in step 5; consumed in step 6. */
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
  name: "Cold-start research",
  description:
    "Cold-start research at signup — boss identity seed → parallel web_search aspect sub-agents → boss synthesis → cheap-tier extract → user_facts proposals + memory_chunks (ADR-0011 + ADR-0022, v2).",
  // Fires from the Google OAuth callback; lifetime-once is enforced by
  // the workflow's own `dedupKey: () => 'cold-start'`.
  trigger: { kind: "event", source: "google.oauth.callback", type: "completed" },
  initialStep: "gather-signals",
  stateSchema,

  initialState(input) {
    const parsed = coldStartWorkflowInputSchema.parse(input.input ?? {});
    return { reason: parsed.reason };
  },

  // Singleton-per-user. The DB-level partial unique index (see
  // packages/db/src/schema/agent.ts → `agent_runs_dedup_key_idx`)
  // turns a duplicate `createRun` into Postgres `23505`. Failed +
  // cancelled rows are excluded from the index so a Perplexity outage
  // isn't a permanent lockout.
  dedupKey: () => COLD_START_DEDUP_KEY,

  steps: {
    "gather-signals": {
      id: "gather-signals",
      async run(ctx) {
        // No in-workflow dedup gate — the partial unique index on
        // `agent_runs.(user_id, workflow_slug, dedup_key)` makes a
        // second concurrent run impossible to even insert, so by the
        // time this step runs, this row is the lone active research
        // run for the user.
        const signals = await collectColdStartSignals(ctx.userId);
        await ctx.log(
          `gather-signals: name="${signals.name}" domain=${signals.emailDomain ?? "n/a"}${
            signals.emailDomainIsConsumer ? " (consumer)" : ""
          } google=${signals.integrations.google ? "yes" : "no"}`,
        );
        return {
          kind: "next",
          state: { ...ctx.state, signals: signals as ColdStartSignals },
          nextStep: "seed",
        };
      },
    },

    seed: {
      id: "seed",
      async run(ctx) {
        if (!ctx.state.signals) {
          throw new Error("[cold-start] seed entered without signals");
        }
        // Stable per-run key so retries of this step share a trace.
        const identity: IdentityAnchor = await resolveIdentity({
          signals: ctx.state.signals,
          runId: ctx.runId,
          stepId: "seed",
          idempotencyKey: `cold-start.seed:${ctx.runId}`,
        });
        await ctx.log(
          `seed: confident=${identity.confident} anchorChars=${identity.anchor.length} citations=${identity.citations.length}`,
        );
        return {
          kind: "next",
          state: { ...ctx.state, identity },
          nextStep: "research-aspects",
        };
      },
    },

    "research-aspects": {
      id: "research-aspects",
      async run(ctx) {
        if (!ctx.state.signals || !ctx.state.identity) {
          throw new Error("[cold-start] research-aspects entered without signals/identity");
        }
        const aspects: AspectFinding[] = await researchAspects({
          signals: ctx.state.signals,
          anchor: ctx.state.identity,
          runId: ctx.runId,
          idempotencyKey: `cold-start.aspects:${ctx.runId}`,
        });
        await ctx.log(
          `research-aspects: ${aspects
            .map((a) => `${a.id}(${a.finding.length}c/${a.citations.length}cit)`)
            .join(" ")}`,
        );
        return {
          kind: "next",
          state: { ...ctx.state, aspects },
          nextStep: "synthesis",
        };
      },
    },

    synthesis: {
      id: "synthesis",
      async run(ctx) {
        if (!ctx.state.signals || !ctx.state.identity || !ctx.state.aspects) {
          throw new Error("[cold-start] synthesis entered without signals/identity/aspects");
        }
        const result: ResearchResult = await synthesizeColdStart({
          signals: ctx.state.signals,
          anchor: ctx.state.identity,
          aspects: ctx.state.aspects,
          runId: ctx.runId,
          stepId: "synthesis",
          idempotencyKey: `cold-start.synthesis:${ctx.runId}`,
        });
        await ctx.log(
          `synthesis: finishReason=${result.meta.finishReason} chars=${result.content.length} citations=${result.citations.length}`,
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
        // Stable per-run key so retries of this step share a trace.
        const proposals: ColdStartProposal[] = await extractColdStartFacts({
          signals: ctx.state.signals,
          research: {
            content: ctx.state.research.content,
            citations: ctx.state.research.citations,
          },
          runId: ctx.runId,
          stepId: "extract-facts",
          idempotencyKey: `cold-start.extract:${ctx.runId}`,
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

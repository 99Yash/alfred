import { z } from "zod";
import { type Workflow } from "@alfred/assistant/execution";
import { proposeFact, writeMemoryChunk } from "..";
import { researchAspects, type AspectFinding } from "./aspects";
import { extractColdStartFacts, type ColdStartProposal } from "./extract";
import { resolveIdentity, type IdentityAnchor } from "./seed";
import { collectColdStartSignals, type ColdStartSignals } from "./signals";
import { synthesizeColdStart, type ResearchResult } from "./synthesis";
import {
  COLD_START_DEDUP_KEY,
  COLD_START_WORKFLOW_SLUG,
  coldStartWorkflowInputSchema,
} from "./workflow-input";

/**
 * Cold-start research workflow (ADR-0011, ADR-0022): signals, seed, aspects,
 * synthesis, extract, persist. Web-only: new users are `gated`, so a Gmail or
 * Calendar read would park in an onboarding run that nobody watches.
 *
 * Each step checkpoints, so a crash re-runs only the failed step. `proposeFact`
 * and `writeMemoryChunk` are idempotent, so a step retry does not write twice.
 */

const aspectFindingSchema = z.object({
  id: z.string(),
  label: z.string(),
  finding: z.string(),
  citations: z.array(z.string()),
});

// `satisfies` ties this to `ColdStartSignals`, so a new field fails typecheck instead of being stripped on resume.
const coldStartSignalsSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  emailDomain: z.string().nullable(),
  emailDomainIsConsumer: z.boolean(),
  integrations: z.object({
    google: z.object({ accountEmail: z.string() }).optional(),
  }),
}) satisfies z.ZodType<ColdStartSignals>;

const stateSchema = z.object({
  reason: z.enum(["signup", "manual"]),
  signals: coldStartSignalsSchema.optional(),
  identity: z
    .object({
      anchor: z.string(),
      confident: z.boolean(),
      citations: z.array(z.string()),
    })
    .optional(),
  aspects: z.array(aspectFindingSchema).optional(),
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
  trigger: { kind: "event", source: "google.oauth.callback", type: "completed" },
  initialStep: "gather-signals",
  stateSchema,
  closure: { kind: "none" },

  initialState(input) {
    const parsed = coldStartWorkflowInputSchema.parse(input.input ?? {});

    return { reason: parsed.reason };
  },

  // `agent_runs_dedup_key_idx` makes a second run for the user fail with 23505.
  // Failed and cancelled runs fall outside the index, so a failure is not a permanent lockout.
  dedupKey: () => COLD_START_DEDUP_KEY,

  steps: {
    "gather-signals": {
      id: "gather-signals",
      async run(ctx) {
        const signals = await collectColdStartSignals(ctx.userId);
        await ctx.log(
          `gather-signals: name="${signals.name}" domain=${signals.emailDomain ?? "n/a"}${
            signals.emailDomainIsConsumer ? " (consumer)" : ""
          } google=${signals.integrations.google ? "yes" : "no"}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, signals },
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
            ...(ctx.state.research.meta.inputTokens === undefined
              ? {}
              : { inputTokens: ctx.state.research.meta.inputTokens }),
            ...(ctx.state.research.meta.outputTokens === undefined
              ? {}
              : { outputTokens: ctx.state.research.meta.outputTokens }),
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

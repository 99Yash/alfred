import { toMessage } from "@alfred/contracts";
import { z } from "zod";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { startRun, type Workflow } from "@alfred/assistant/execution";
import { proposeFact } from "@alfred/assistant/knowledge";
import { SKILL_DOCUMENTATION_WORKFLOW_SLUG } from "./skill-documentation-workflow-input";
import { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "./revisions";
import { collectSkillLearnContext, type SkillLearnContext } from "./context";
import { distillSkill } from "./distill";
import { type ParsedMention } from "./mentions";
import {
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  learnSkillWorkflowInputSchema,
} from "./workflow-input";

/**
 * `learn-skill`: sync phase 1 of Learn (ADR-0017).
 * Steps: gather context; one cheap-tier distill call; in one transaction, write a
 * `distilled` revision, activate the skill, rename it, and propose facts. Then enqueue
 * `skill-documentation`.
 * `dedupKey` blocks concurrent Learn clicks per skill. Retries are safe: facts and
 * revisions are idempotent. A crash re-bills one cheap call.
 * Review happens on the proposed `user_facts`, not here. The body commits on success.
 */

const distillProposalSchema = z.object({
  key: z.string(),
  value: z.string(),
  confidence: z.number(),
  rationale: z.string(),
});

const distillOutputSchema = z.object({
  suggestedName: z.string(),
  body: z.string(),
  proposals: z.array(distillProposalSchema),
  mentions: z.array(
    z.object({
      raw: z.string(),
      kind: z.enum(["integration", "skill", "collaborator", "unresolved"]),
      slug: z.string(),
      index: z.number(),
    }),
  ),
});

// `satisfies` ties this to `SkillLearnContext`, so a new field fails typecheck instead of being dropped on resume.
const skillLearnContextSchema = z.object({
  userId: z.string(),
  user: z.object({ name: z.string(), email: z.string() }),
  facts: z.array(
    z.object({
      key: z.string(),
      value: z.unknown(),
      confidence: z.number(),
    }),
  ),
  connectedIntegrations: z.array(z.string()),
  existingSkillSlugs: z.array(z.string()),
}) satisfies z.ZodType<SkillLearnContext>;

const stateSchema = z.object({
  skillId: z.string(),
  prompt: z.string(),
  reason: z.enum(["manual", "regen"]),
  context: skillLearnContextSchema.optional(),
  distill: distillOutputSchema.optional(),
});

type State = z.infer<typeof stateSchema>;

export const learnSkillWorkflow: Workflow<State> = {
  slug: LEARN_SKILL_WORKFLOW_SLUG,
  name: "Learn skill",
  description:
    "Sync phase of skill authoring — distill the user's prompt + memory into a v1 skill body and fact proposals (ADR-0017).",
  // From the skills API (create and `/:id/relearn`). No cron.
  trigger: { kind: "manual" },
  initialStep: "gather",
  stateSchema,

  initialState(input) {
    const parsed = learnSkillWorkflowInputSchema.parse(input.input ?? {});

    return {
      skillId: parsed.skillId,
      prompt: parsed.prompt,
      reason: parsed.reason,
    };
  },

  // One run per skill; different skills run in parallel.
  dedupKey: ({ input }) => {
    const parsed = learnSkillWorkflowInputSchema.parse(input ?? {});

    return learnSkillDedupKey(parsed.skillId);
  },

  // The UI reads `skill_runs.status`, so close it on any terminal path or the card
  // stays "in progress". Each branch records its own status.
  closure: {
    kind: "client",
    async onTerminal(ctx) {
      switch (ctx.outcome) {
        case "failed":
          await finalizeSkillRun({ agentRunId: ctx.runId, status: "failed" });

          return;
        case "cancelled":
          await finalizeSkillRun({ agentRunId: ctx.runId, status: "cancelled" });

          return;
        default: {
          const unhandled: never = ctx;
          throw new Error(`[learn-skill] unhandled terminal outcome: ${JSON.stringify(unhandled)}`);
        }
      }
    },
  },

  steps: {
    gather: {
      id: "gather",
      async run(ctx) {
        // Record the run first so the UI shows "in progress". Idempotent on agent_run_id.
        await recordSkillRun({
          userId: ctx.userId,
          skillId: ctx.state.skillId,
          kind: "learn",
          agentRunId: ctx.runId,
        });

        const context = await collectSkillLearnContext(ctx.userId);
        await ctx.log(
          `gather: facts=${context.facts.length} integrations=${context.connectedIntegrations.length} skills=${context.existingSkillSlugs.length}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, context },
          nextStep: "distill",
        };
      },
    },

    distill: {
      id: "distill",
      async run(ctx) {
        if (!ctx.state.context) {
          throw new Error("[learn-skill] distill entered without context");
        }

        // Stable key so retries of one step share a trace.
        const result = await distillSkill({
          context: ctx.state.context,
          prompt: ctx.state.prompt,
          runId: ctx.runId,
          stepId: "distill",
          idempotencyKey: `learn-skill.distill:${ctx.runId}`,
        });

        await ctx.log(
          `distill: name="${result.suggestedName}" body=${result.body.length}ch proposals=${result.proposals.length} mentions=${result.mentions.length}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, distill: result },
          nextStep: "persist",
        };
      },
    },

    persist: {
      id: "persist",
      async run(ctx) {
        if (!ctx.state.distill) {
          throw new Error("[learn-skill] persist entered without distill output");
        }

        const { distill } = ctx.state;
        const mentions: ParsedMention[] = distill.mentions;

        const commit = await commitSkillRevision({
          userId: ctx.userId,
          skillId: ctx.state.skillId,
          kind: "distilled",
          body: distill.body,
          newName: distill.suggestedName,
          createdByRunId: ctx.runId,
          metadata: {
            mentions,
            generatedAt: new Date().toISOString(),
            reason: ctx.state.reason,
          },
        });

        let inserted = 0;
        let skipped = 0;

        for (const p of distill.proposals) {
          const fact = await proposeFact({
            userId: ctx.userId,
            key: p.key,
            value: p.value,
            confidence: p.confidence,
            source: {
              kind: "agent",
              id: ctx.runId,
              meta: {
                rationale: p.rationale,
                workflow: LEARN_SKILL_WORKFLOW_SLUG,
                skillId: ctx.state.skillId,
              },
            },
          });

          if (fact) inserted++;
          else skipped++;
        }

        await finalizeSkillRun({
          agentRunId: ctx.runId,
          status: "completed",
          producedRevisionId: commit.revisionId,
        });

        // Fire-and-forget: a failed enqueue must not undo the commit. A 23505 means a doc
        // run is already going; it will re-read the latest revision.
        let docRunId: string | null = null;
        let docEnqueueStatus: "enqueued" | "deduplicated" | "failed" = "enqueued";

        try {
          const created = await startRun({
            userId: ctx.userId,
            workflowSlug: SKILL_DOCUMENTATION_WORKFLOW_SLUG,
            input: {
              skillId: ctx.state.skillId,
              triggeringLearnRunId: ctx.runId,
            },
            metadata: {
              triggeringLearnRunId: ctx.runId,
            },
            // eventId is the parent run id, so History can find each doc run.
            trigger: {
              kind: "event",
              source: "learn-skill",
              type: "completed",
              eventId: `learn-skill:${ctx.runId}`,
            },
            workflowRevisionId: null,
            occurrence: {
              kind: "event",
              workflowId: SKILL_DOCUMENTATION_WORKFLOW_SLUG,
              provider: "learn-skill",
              eventId: `learn-skill:${ctx.runId}`,
            },
          });

          docRunId = created.runId;
        } catch (err) {
          if (isUniqueViolation(err)) {
            docEnqueueStatus = "deduplicated";
            await ctx.log(
              `persist: skill-documentation already in flight for skill=${ctx.state.skillId}; the running doc will pick up the latest revision`,
            );
          } else {
            docEnqueueStatus = "failed";
            await ctx.log(`persist: failed to enqueue skill-documentation: ${toMessage(err)}`);
          }
        }

        await ctx.log(
          `persist: revisionId=${commit.revisionId} status=${commit.skillStatus} facts=${inserted}/${distill.proposals.length} (skipped=${skipped}) doc=${docEnqueueStatus}${docRunId ? `:${docRunId}` : ""}`,
        );

        return {
          kind: "done",
          state: ctx.state,
          output: {
            skillId: ctx.state.skillId,
            revisionId: commit.revisionId,
            skillStatus: commit.skillStatus,
            factsProposed: inserted,
            factsSkipped: skipped,
            mentionCount: mentions.length,
            documentationRunId: docRunId,
            documentationEnqueueStatus: docEnqueueStatus,
          },
        };
      },
    },
  },
};

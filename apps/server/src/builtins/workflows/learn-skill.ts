import {
  collectSkillLearnContext,
  commitSkillRevision,
  createRun,
  distillSkill,
  enqueueRun,
  finalizeSkillRun,
  isUniqueViolation,
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  learnSkillWorkflowInputSchema,
  proposeFact,
  recordSkillRun,
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  type ParsedMention,
  type SkillLearnContext,
  type SkillProposal,
  type Workflow,
} from "@alfred/api/backend";
import { z } from "zod";
import { toMessage } from "@alfred/contracts";

/**
 * `learn-skill` — sync phase 1 of dimension's two-phase Learn (ADR-0017).
 *
 * Steps:
 *   1. gather   — read user + active facts + connected integrations +
 *                 existing skill slugs into a context bundle.
 *   2. distill  — one cheap-tier structured-output call returning a body,
 *                 a suggested name, fact proposals, and parsed mentions.
 *   3. persist  — within one transaction:
 *                   * write a `skill_revisions` row (`kind='distilled'`),
 *                   * advance `skills.current_revision_id`,
 *                   * flip status `draft` → `active` on first revision,
 *                   * update the display name from `suggestedName`,
 *                   * propose each fact via `proposeFact()` (existing
 *                     auto-confirm / rejection-guard / active-dup logic).
 *                 Then mark the `skill_runs` row terminal.
 *
 * The async `skill-documentation` workflow is enqueued from `persist`
 * once that step lands (12c). For 12b the persist step finishes the run.
 *
 * Idempotency:
 *   - Trigger-side: `dedupKey: learn-skill:<skillId>` blocks concurrent
 *     Learn clicks for the same skill via the partial unique index on
 *     `agent_runs.(user_id, workflow_slug, dedup_key)`.
 *   - Step-side: `proposeFact` and `commitSkillRevision` are both
 *     idempotent on retry (rejection-guard + active-dup guard for facts;
 *     append-only revisions with the same content are tolerated).
 *   - Cost: a worker crash mid-distill re-bills the cheap-tier call.
 *     Distill is ~$0.001/call so this is a non-issue.
 *
 * The Learn HIL pattern (approve / regenerate / reject) lives on the
 * `user_facts` rows produced here, NOT on this workflow. Auto-confirmed
 * facts (≥0.85) land active immediately; lower-confidence proposals
 * surface in the existing memory page review queue. The skill body
 * itself isn't gated — it commits the moment distill succeeds.
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

const stateSchema = z.object({
  skillId: z.string(),
  prompt: z.string(),
  reason: z.enum(["manual", "regen"]),
  context: z
    .object({
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
    })
    .optional(),
  distill: distillOutputSchema.optional(),
});
type State = z.infer<typeof stateSchema>;

export const learnSkillWorkflow: Workflow<State> = {
  slug: LEARN_SKILL_WORKFLOW_SLUG,
  name: "Learn skill",
  description:
    "Sync phase of skill authoring — distill the user's prompt + memory into a v1 skill body and fact proposals (ADR-0017).",
  // User-initiated from the skills CRUD surface (/api/skills POST + the
  // /:id/relearn endpoint). No cron path.
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

  // Concurrent Learn clicks on the same skill are blocked at the DB level.
  // Different skills run in parallel (different dedup keys).
  dedupKey: ({ input }) => {
    const parsed = learnSkillWorkflowInputSchema.parse(input ?? {});
    return learnSkillDedupKey(parsed.skillId);
  },

  async onTerminalFailure(ctx) {
    await finalizeSkillRun({ agentRunId: ctx.runId, status: "failed" });
  },

  steps: {
    gather: {
      id: "gather",
      async run(ctx) {
        // Record the Learn run row up-front so the skill-detail UI can
        // render "in progress" the moment the workflow picks up. The
        // helper is idempotent on agent_run_id, so a worker-crash retry
        // doesn't double-write.
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
          state: { ...ctx.state, context: context as SkillLearnContext },
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
        // Stable per-run key so api_call_log + Langfuse trace tie
        // attempts of the same step together. Cheap-tier model — the
        // re-bill on retry is not load-bearing.
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
        for (const p of distill.proposals as SkillProposal[]) {
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

        // Phase 2: kick off async deep documentation. Fire-and-forget —
        // a failure to enqueue the doc workflow must NOT undo the v1
        // commit that already succeeded. Per-skill dedup means a Learn
        // re-fire while an earlier doc is still running surfaces as
        // 23505 here; we log + continue so the in-flight doc finishes
        // (it will re-read the latest revision in its gather step).
        let docRunId: string | null = null;
        let docEnqueueStatus: "enqueued" | "deduplicated" | "failed" = "enqueued";
        try {
          const created = await createRun({
            userId: ctx.userId,
            workflowSlug: SKILL_DOCUMENTATION_WORKFLOW_SLUG,
            input: {
              skillId: ctx.state.skillId,
              triggeringLearnRunId: ctx.runId,
            },
            metadata: {
              triggeringLearnRunId: ctx.runId,
            },
            // Parent-workflow-driven spawn: the eventId is the parent
            // run id so History/query surfaces can locate every doc run
            // emitted by a specific learn run.
            trigger: {
              kind: "event",
              source: "learn-skill",
              type: "completed",
              eventId: `learn-skill:${ctx.runId}`,
            },
          });
          await enqueueRun(created.runId);
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

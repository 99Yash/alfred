import { z } from "zod";
import { type Workflow } from "@alfred/assistant/execution";
import { send } from "@alfred/assistant/delivery";
import { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "./revisions";
import { composeSkillDocumentation } from "./compose";
import {
  collectSkillDocumentationContext,
  type SkillDocumentationContext,
} from "./skill-documentation-context";
import { composeSkillDocumentationEmail } from "./email";
import {
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
} from "./skill-documentation-workflow-input";

/**
 * `skill-documentation`: async phase 2 of Learn (ADR-0017), enqueued by `learn-skill`.
 * Steps: gather the v1 body plus facts, documents, and memory hits; one boss-tier call
 * rewrites the body with that evidence; write a `documented` revision; notify once.
 * The per-skill dedup index makes a second Learn click fail with 23505; the running doc
 * re-reads the latest v1. A crash inside compose re-bills the call, which is acceptable.
 * There is no approval gate. A reject cancels the run, but a sent email stays sent.
 */

const skillDocumentationContextSchema = z.object({
  userId: z.string(),
  user: z.object({ name: z.string(), email: z.string() }),
  skill: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    currentRevisionId: z.string(),
    currentBody: z.string(),
  }),
  facts: z.array(
    z.object({
      key: z.string(),
      value: z.unknown(),
      confidence: z.number(),
    }),
  ),
  // Stored opaquely: zod round-trips buy nothing. The hits are already model-facing
  // (`ModelFacingHit`), so no credential identity enters the run store.
  documentHits: z.array(z.custom<SkillDocumentationContext["documentHits"][number]>()),
  memoryHits: z.array(z.custom<SkillDocumentationContext["memoryHits"][number]>()),
  sourceCounts: z.record(z.string(), z.number()),
}) satisfies z.ZodType<SkillDocumentationContext>;

const stateSchema = z.object({
  skillId: z.string(),
  triggeringLearnRunId: z.string().optional(),
  context: skillDocumentationContextSchema.optional(),
  documented: z
    .object({
      body: z.string(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
  revisionId: z.string().optional(),
});

type State = z.infer<typeof stateSchema>;

export const skillDocumentationWorkflow: Workflow<State> = {
  slug: SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  name: "Skill documentation",
  description:
    "Async deep-documentation pass for a skill — hybrid search + boss-tier compose + email notify (ADR-0017).",
  // `source = 'learn-skill'` lets History filter by parent.
  trigger: { kind: "event", source: "learn-skill", type: "completed" },
  initialStep: "gather-context",
  stateSchema,

  initialState(input) {
    const parsed = skillDocumentationInputSchema.parse(input.input ?? {});

    return {
      skillId: parsed.skillId,
      triggeringLearnRunId: parsed.triggeringLearnRunId,
    };
  },

  // One doc run per skill; the survivor re-reads the latest v1.
  dedupKey: ({ input }) => {
    const parsed = skillDocumentationInputSchema.parse(input ?? {});

    return skillDocumentationDedupKey(parsed.skillId);
  },

  // Each branch records its own status, so a cancel is not recorded as a failure.
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
          throw new Error(
            `[skill-documentation] unhandled terminal outcome: ${JSON.stringify(unhandled)}`,
          );
        }
      }
    },
  },

  steps: {
    "gather-context": {
      id: "gather-context",
      async run(ctx) {
        // Record the run first, so the UI shows "documenting" at once.
        await recordSkillRun({
          userId: ctx.userId,
          skillId: ctx.state.skillId,
          kind: "document",
          agentRunId: ctx.runId,
        });

        const context = await collectSkillDocumentationContext({
          userId: ctx.userId,
          skillId: ctx.state.skillId,
        });

        await ctx.log(
          `gather-context: facts=${context.facts.length} docHits=${context.documentHits.length} memHits=${context.memoryHits.length} sources=${Object.keys(context.sourceCounts).join(",") || "none"}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, context },
          nextStep: "compose",
        };
      },
    },

    compose: {
      id: "compose",
      async run(ctx) {
        if (!ctx.state.context) {
          throw new Error("[skill-doc] compose entered without context");
        }

        const { context } = ctx.state;

        const composed = await composeSkillDocumentation({
          context,
          runId: ctx.runId,
          stepId: "compose",
          idempotencyKey: `skill-doc.compose:${ctx.runId}`,
        });

        await ctx.log(
          `compose: body=${composed.body.length}ch tokens=${composed.inputTokens ?? "?"}/${composed.outputTokens ?? "?"}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, documented: composed },
          nextStep: "persist-revision",
        };
      },
    },

    "persist-revision": {
      id: "persist-revision",
      async run(ctx) {
        if (!ctx.state.context || !ctx.state.documented) {
          throw new Error("[skill-doc] persist-revision entered without context/documented");
        }

        const { context } = ctx.state;

        const commit = await commitSkillRevision({
          userId: ctx.userId,
          skillId: ctx.state.skillId,
          kind: "documented",
          body: ctx.state.documented.body,
          createdByRunId: ctx.runId,
          metadata: {
            generatedAt: new Date().toISOString(),
            previousRevisionId: context.skill.currentRevisionId,
            sourceCounts: context.sourceCounts,
            documentHitCount: context.documentHits.length,
            memoryHitCount: context.memoryHits.length,
            ...(ctx.state.documented.inputTokens !== undefined
              ? { inputTokens: ctx.state.documented.inputTokens }
              : {}),
            ...(ctx.state.documented.outputTokens !== undefined
              ? { outputTokens: ctx.state.documented.outputTokens }
              : {}),
            ...(ctx.state.triggeringLearnRunId !== undefined
              ? { triggeringLearnRunId: ctx.state.triggeringLearnRunId }
              : {}),
          },
        });

        await ctx.log(
          `persist-revision: revisionId=${commit.revisionId} previousId=${context.skill.currentRevisionId}`,
        );

        return {
          kind: "next",
          state: { ...ctx.state, revisionId: commit.revisionId },
          nextStep: "notify",
        };
      },
    },

    notify: {
      id: "notify",
      async run(ctx) {
        if (!ctx.state.context || !ctx.state.documented || !ctx.state.revisionId) {
          throw new Error("[skill-doc] notify entered without context/documented/revisionId");
        }

        const { context } = ctx.state;

        const email = await composeSkillDocumentationEmail({
          context,
          documentedBody: ctx.state.documented.body,
        });

        const result = await send({
          userId: ctx.userId,
          kind: "skill_documented",
          // Same revision: a retry is a no-op. A re-Learn has a new revision and a new email.
          idempotencyKey: `skill-doc:${ctx.state.revisionId}`,
          subject: email.subject,
          html: email.html,
          text: email.text,
          payload: {
            skillId: ctx.state.skillId,
            skillSlug: context.skill.slug,
            revisionId: ctx.state.revisionId,
            sourceCounts: context.sourceCounts,
          },
        });

        await ctx.log(`notify: status=${result.status} emailSendId=${result.emailSendId}`);

        await finalizeSkillRun({
          agentRunId: ctx.runId,
          status: "completed",
          producedRevisionId: ctx.state.revisionId,
        });

        return {
          kind: "done",
          state: ctx.state,
          output: {
            skillId: ctx.state.skillId,
            revisionId: ctx.state.revisionId,
            emailStatus: result.status,
            emailSendId: result.emailSendId,
            documentHitCount: context.documentHits.length,
            memoryHitCount: context.memoryHits.length,
          },
        };
      },
    },
  },
};

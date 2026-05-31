import {
  collectSkillDocumentationContext,
  commitSkillRevision,
  composeSkillDocumentation,
  composeSkillDocumentationEmail,
  finalizeSkillRun,
  notify,
  recordSkillRun,
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
  type SkillDocumentationContext,
  type Workflow,
} from "@alfred/api";
import { z } from "zod";

/**
 * `skill-documentation` — async phase 2 of dimension's two-phase Learn
 * (ADR-0017). Enqueued by `learn-skill`'s persist step once a v1
 * (`distilled`) revision commits.
 *
 * Steps:
 *   1. gather-context  — pull the skill row + v1 body + active facts +
 *                        top-K hits from `documents`/`chunks`
 *                        (semanticSearch) and `memory_chunks`
 *                        (recallMemory). Both queries use the v1 body
 *                        verbatim — distill already produced the
 *                        canonical statement of the skill's intent.
 *   2. compose         — one boss-tier `meteredGenerateText` call that
 *                        rewrites the body integrating the retrieved
 *                        evidence (without softening the v1 directives).
 *   3. persist-revision — write a `skill_revisions` row with
 *                         `kind='documented'`, advance
 *                         `skills.current_revision_id`. Subsequent Learn
 *                         clicks will distill against this v2 body.
 *   4. notify          — `notify({ kind: 'skill_documented' })` with
 *                        idempotency key per revision so a worker-crash
 *                        retry of the step doesn't double-send.
 *
 * Idempotency:
 *   - Trigger-side: per-skill dedup via the partial unique index. If a
 *     second Learn click lands while this run is still executing, the
 *     second skill-documentation insert fails with 23505 — the first
 *     run continues and re-reads `current_revision_id` in
 *     `gather-context`, so it documents whatever the latest v1 is at
 *     gather time.
 *   - Step-side: `commitSkillRevision` is append-only on a unique row;
 *     `notify()` is idempotent on `(user_id, idempotency_key)`. A
 *     worker-crash retry inside compose re-bills the boss-tier call —
 *     acceptable at single-skill cadence; not worth a checkpoint cache.
 *   - The notify idempotency key uses the v2 revision id so a re-Learn
 *     that produces a NEW documented revision sends a fresh email,
 *     while a worker retry of the SAME revision is a no-op.
 *
 * Cancellation: there is no per-doc HIL gate. Reject in the UI cancels
 * `agent_runs.status = 'cancelled'`; the executor stops scheduling
 * further steps. If the run already passed `notify`, the email is gone.
 * That matches dimension's "the email dispatches even when I don't
 * approve, as long as I don't reject" behavior.
 */

const stateSchema = z.object({
  skillId: z.string(),
  triggeringLearnRunId: z.string().optional(),
  context: z
    .object({
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
      // The hit shapes are large; persist them opaquely rather than
      // re-validating jsonb between steps. State is checkpointed to DB
      // and re-loaded on resume — full round-trips through zod for the
      // raw search hits buy nothing here.
      documentHits: z.array(z.unknown()),
      memoryHits: z.array(z.unknown()),
      sourceCounts: z.record(z.string(), z.number()),
    })
    .optional(),
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
  // Spawned by the parent `learn-skill` workflow once the sync phase
  // commits a revision; `event.source = 'learn-skill'` captures that
  // relationship for History filters.
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

  // Per-skill singleton. Two Learn clicks in quick succession produce
  // one doc run, not two; the surviving run re-reads the latest v1.
  dedupKey: ({ input }) => {
    const parsed = skillDocumentationInputSchema.parse(input ?? {});
    return skillDocumentationDedupKey(parsed.skillId);
  },

  steps: {
    "gather-context": {
      id: "gather-context",
      async run(ctx) {
        // Record the doc run row up-front so the skill-detail UI can
        // render "documenting…" the moment this workflow picks up.
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
          state: { ...ctx.state, context: context as SkillDocumentationContext },
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
        // State persists hits as z.unknown[] (jsonb passthrough); the
        // compose helper consumes them as the typed shape that
        // collectSkillDocumentationContext returned originally.
        const context = ctx.state.context as SkillDocumentationContext;
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
        const context = ctx.state.context as SkillDocumentationContext;
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
            inputTokens: ctx.state.documented.inputTokens,
            outputTokens: ctx.state.documented.outputTokens,
            triggeringLearnRunId: ctx.state.triggeringLearnRunId,
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
        const context = ctx.state.context as SkillDocumentationContext;

        const email = await composeSkillDocumentationEmail({
          context,
          documentedBody: ctx.state.documented.body,
        });

        const result = await notify({
          userId: ctx.userId,
          kind: "skill_documented",
          // Per-revision idempotency: a worker retry of this step is a
          // no-op (same key); a fresh re-Learn produces a different
          // revisionId and therefore a fresh email.
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

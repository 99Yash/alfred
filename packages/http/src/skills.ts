import { Errors } from "@alfred/contracts";
import { db } from "@alfred/db";
import { skills } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { randomUUID } from "node:crypto";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";
import { startRun } from "@alfred/assistant/execution";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import {
  recordSkillRun,
  slugifyForUser,
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  type LearnSkillWorkflowInput,
} from "@alfred/assistant/skills";

/**
 * Skill authoring HTTP routes.
 *
 *   POST /api/skills              → create a draft skill + enqueue learn-skill
 *   POST /api/skills/:id/relearn  → re-run learn-skill on an existing skill
 *
 * Both handlers atomically insert (where applicable) and enqueue. The
 * Replicache puller picks up the new rows on the next poke; the client
 * never directly mutates skills/runs in v1 (see m12 plan D6).
 */
export const skillsRoutes = new Elysia({ prefix: "/api/skills", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .post(
        "/",
        async ({ user, body }) => {
          /* `prompt` is optional so the client can instantly create a draft
           * skill and navigate into the editor; the learn run only fires when
           * the caller actually supplies prompt text. */
          const rawName = body.name?.trim() ?? "";
          const name = rawName.length > 0 ? rawName : "Untitled skill";
          const slug = await slugifyForUser(user.id, name);

          const inserted = await db()
            .insert(skills)
            .values({
              userId: user.id,
              slug,
              name,
              status: "draft",
              currentRevisionId: null,
              isBuiltin: false,
            })
            .returning({ id: skills.id, slug: skills.slug });

          const skill = inserted[0];
          if (!skill) throw Errors.InternalServerError("Failed to insert skill");

          const trimmedPrompt = body.prompt?.trim() ?? "";
          if (trimmedPrompt.length === 0) {
            /* No learn run for an empty draft. Fire a poke so the client
             * sees the new row before its detail page renders. */
            emitReplicachePokes([user.id], skill.id);
            return { skillId: skill.id, slug: skill.slug, runId: null };
          }

          const input: LearnSkillWorkflowInput = {
            skillId: skill.id,
            prompt: trimmedPrompt,
            reason: "manual",
          };
          const created = await startRun({
            userId: user.id,
            workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
            input,
            trigger: { kind: "manual" },
            occurrence: {
              kind: "manual",
              requestId: `initial:${skill.id}`,
            },
          });
          // Record the learn run up-front so the skill-detail UI can render
          // "in progress" immediately. `gather` re-records idempotently on
          // agent_run_id, so `startRun` enqueueing before this write commits is
          // safe — the workflow writes (never reads) this linkage first thing.
          await recordSkillRun({
            userId: user.id,
            skillId: skill.id,
            kind: "learn",
            agentRunId: created.runId,
          });

          return { skillId: skill.id, slug: skill.slug, runId: created.runId };
        },
        {
          body: t.Object({
            name: t.Optional(t.String({ maxLength: 200 })),
            prompt: t.Optional(t.String({ maxLength: 8_000 })),
          }),
        },
      )
      .post(
        "/:id/relearn",
        async ({ params, body, user }) => {
          const owner = await db()
            .select({ id: skills.id })
            .from(skills)
            .where(and(eq(skills.id, params.id), eq(skills.userId, user.id)))
            .limit(1);
          if (!owner[0]) throw Errors.NotFoundError("Skill not found");

          const input: LearnSkillWorkflowInput = {
            skillId: params.id,
            prompt: body.prompt,
            reason: "regen",
          };
          try {
            const created = await startRun({
              userId: user.id,
              workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
              input,
              trigger: { kind: "manual" },
              occurrence: {
                kind: "manual",
                requestId: randomUUID(),
              },
            });
            // Up-front UI-progress record; the `gather` step re-records
            // idempotently, so enqueue-before-commit here is safe.
            await recordSkillRun({
              userId: user.id,
              skillId: params.id,
              kind: "learn",
              agentRunId: created.runId,
            });
            return { runId: created.runId };
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw Errors.ConflictError("A learn run is already in flight for this skill", {
                dedupKey: learnSkillDedupKey(params.id),
              });
            }
            throw err;
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            prompt: t.String({ minLength: 1, maxLength: 8_000 }),
          }),
        },
      ),
  );

import { db } from "@alfred/db";
import { skills } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { emitReplicachePokes } from "../../events/replicache-events";
import { authMacro } from "../../middleware/auth";
import { ConflictError, InternalServerError, NotFoundError } from "../../middleware/errors";
import { createRun, enqueueRun } from "../agent";
import { isUniqueViolation } from "../agent/service";
import { recordSkillRun } from "./revisions";
import { slugifyForUser } from "./slug";
import {
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  type LearnSkillWorkflowInput,
} from "./workflow-input";

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
  .guard({ auth: true }, (app) =>
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
          if (!skill) throw new InternalServerError("Failed to insert skill");

          const trimmedPrompt = body.prompt?.trim() ?? "";
          if (trimmedPrompt.length === 0) {
            /* No learn run for an empty draft. Fire a poke so the client
             * sees the new row before its detail page renders. */
            emitReplicachePokes([user.id]);
            return { skillId: skill.id, slug: skill.slug, runId: null };
          }

          const input: LearnSkillWorkflowInput = {
            skillId: skill.id,
            prompt: trimmedPrompt,
            reason: "manual",
          };
          const created = await createRun({
            userId: user.id,
            workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
            input,
            trigger: { kind: "manual" },
          });
          await recordSkillRun({
            userId: user.id,
            skillId: skill.id,
            kind: "learn",
            agentRunId: created.runId,
          });
          await enqueueRun(created.runId);

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
          if (!owner[0]) throw new NotFoundError("Skill not found");

          const input: LearnSkillWorkflowInput = {
            skillId: params.id,
            prompt: body.prompt,
            reason: "regen",
          };
          try {
            const created = await createRun({
              userId: user.id,
              workflowSlug: LEARN_SKILL_WORKFLOW_SLUG,
              input,
              trigger: { kind: "manual" },
            });
            await recordSkillRun({
              userId: user.id,
              skillId: params.id,
              kind: "learn",
              agentRunId: created.runId,
            });
            await enqueueRun(created.runId);
            return { runId: created.runId };
          } catch (err) {
            if (isUniqueViolation(err)) {
              throw new ConflictError("A learn run is already in flight for this skill", {
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

import { db } from "@alfred/db";
import { skills } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { Elysia, status, t } from "elysia";
import { authMacro } from "../../middleware/auth";
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
export const skillsRoutes = new Elysia({ prefix: "/api/skills" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .post(
        "/",
        async ({ user, body }) => {
          const slug = await slugifyForUser(user.id, body.name);

          const inserted = await db()
            .insert(skills)
            .values({
              userId: user.id,
              slug,
              name: body.name.trim(),
              status: "draft",
              currentRevisionId: null,
              isBuiltin: false,
            })
            .returning({ id: skills.id, slug: skills.slug });

          const skill = inserted[0];
          if (!skill) return status(500, { message: "Failed to insert skill" });

          const input: LearnSkillWorkflowInput = {
            skillId: skill.id,
            prompt: body.prompt,
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
            name: t.String({ minLength: 1, maxLength: 200 }),
            prompt: t.String({ minLength: 1, maxLength: 8_000 }),
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
          if (!owner[0]) return status(404, { message: "Skill not found" });

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
              return status(409, {
                message: "A learn run is already in flight for this skill",
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

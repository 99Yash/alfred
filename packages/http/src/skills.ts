import { Errors } from "@alfred/contracts";
import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";
import { createSkill, relearnSkill } from "@alfred/assistant/skills";

/** Create or relearn a skill. The client never writes skills directly; it gets rows by pull. */
export const skillsRoutes = new Elysia({ prefix: "/api/skills", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .post(
        "/",
        ({ user, body }) => createSkill({ userId: user.id, name: body.name, prompt: body.prompt }),
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
          const outcome = await relearnSkill({
            userId: user.id,
            skillId: params.id,
            prompt: body.prompt,
          });

          switch (outcome.kind) {
            case "not_found":
              throw Errors.NotFoundError("Skill not found");
            case "in_flight":
              throw Errors.ConflictError("A learn run is already in flight for this skill", {
                dedupKey: outcome.dedupKey,
              });
            case "started":
              return { runId: outcome.runId };
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

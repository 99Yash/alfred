import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";
import {
  isInternalWorkflowSlug,
  startRun,
  getRun,
  replayRun,
  redeliverRun,
  wakeRun,
  listPublicWorkflows,
} from "@alfred/assistant/execution";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { approvalKindSchema, Errors, toMessage } from "@alfred/contracts";
import { requireOnboarded } from "./middleware/onboarding";

export const agent = new Elysia({ prefix: "/api/agent", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .get("/workflows", () => {
        return {
          workflows: listPublicWorkflows().map((w) => ({
            slug: w.slug,
            description: w.description,
            initialStep: w.initialStep,
          })),
        };
      })
      .post(
        "/runs",
        async ({ body, user }) => {
          if (isInternalWorkflowSlug(body.workflowSlug)) {
            throw Errors.NotFoundError("Workflow not found");
          }

          try {
            const { runId } = await startRun({
              userId: user.id,
              workflowSlug: body.workflowSlug,
              brief: body.brief,
              input: body.input,
              metadata: body.metadata,
              // An HTTP run is always manual (ADR-0027).
              trigger: { kind: "manual" },
              occurrence: {
                kind: "manual",
                requestId: body.requestId,
              },
            });

            return { runId };
          } catch (err) {
            // A `dedupKey` workflow's unique index raises 23505 on a duplicate. Report a 409.
            if (isUniqueViolation(err)) {
              throw Errors.ConflictError(
                `An active run for workflow "${body.workflowSlug}" already exists.`,
              );
            }

            const msg = toMessage(err);
            throw Errors.BadRequestError(msg);
          }
        },
        {
          body: t.Object({
            workflowSlug: t.String({ minLength: 1, maxLength: 120 }),
            requestId: t.String({ minLength: 1, maxLength: 200 }),
            brief: t.Optional(t.String({ maxLength: 4_000 })),
            input: t.Optional(t.Unknown()),
            metadata: t.Optional(t.Record(t.String(), t.Unknown())),
          }),
        },
      )
      .post(
        "/runs/:runId/replay",
        async ({ params, body, user }) => {
          const replayed = await replayRun({
            userId: user.id,
            runId: params.runId,
            requestId: body.requestId,
            revisionChoice: body.revisionChoice,
          });

          await redeliverRun(replayed.runId);

          return replayed;
        },
        {
          params: t.Object({ runId: t.String() }),
          body: t.Object({
            requestId: t.String({ minLength: 1, maxLength: 200 }),
            revisionChoice: t.Union([t.Literal("original"), t.Literal("latest")]),
          }),
        },
      )
      .get(
        "/runs/:runId",
        async ({ params, user }) => {
          const run = await getRun(params.runId, user.id);

          if (!run) throw Errors.NotFoundError("Run not found");

          return run;
        },
        { params: t.Object({ runId: t.String() }) },
      )
      .post(
        "/runs/:runId/signal",
        async ({ params, body, user }) => {
          const run = await getRun(params.runId, user.id);

          if (!run) throw Errors.NotFoundError("Run not found");

          const woken = await wakeRun({ runId: params.runId, match: body.match });

          if (!woken) throw Errors.ConflictError("Run not waiting on a matching condition");

          return { ok: true };
        },
        {
          params: t.Object({ runId: t.String() }),
          body: t.Object({
            match: t.Optional(
              t.Union([
                t.Object({
                  kind: t.Literal("hil"),
                  approvalId: t.String({ minLength: 1, maxLength: 120 }),
                  approvalKind: t.Optional(t.Enum(approvalKindSchema.enum)),
                }),
                t.Object({
                  kind: t.Literal("signal"),
                  name: t.String({ minLength: 1, maxLength: 120 }),
                }),
                t.Object({ kind: t.Literal("any") }),
              ]),
            ),
          }),
        },
      ),
  );

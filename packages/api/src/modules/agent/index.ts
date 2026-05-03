import { Elysia, status, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { runOnce } from "./executor";
import { enqueueRun, closeAgentQueue } from "./queue";
import { listWorkflows, registerWorkflow } from "./registry";
import { createRun, getRun, isUniqueViolation, signalRun } from "./service";
import { startAgentWorker, stopAgentWorker } from "./worker";

export {
  registerWorkflow,
  listWorkflows,
  createRun,
  getRun,
  signalRun,
  enqueueRun,
  runOnce,
  startAgentWorker,
  stopAgentWorker,
};
export { closeAgentQueue };
export type {
  RunStatus,
  Step,
  StepContext,
  StepResult,
  WakeCondition,
  Workflow,
  WorkflowInput,
} from "./types";

export const agent = new Elysia({ prefix: "/api/agent" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/workflows", () => {
        return {
          workflows: listWorkflows().map((w) => ({
            slug: w.slug,
            description: w.description,
            initialStep: w.initialStep,
          })),
        };
      })
      .post(
        "/runs",
        async ({ body, user }) => {
          try {
            const { runId } = await createRun({
              userId: user.id,
              workflowSlug: body.workflowSlug,
              brief: body.brief,
              input: body.input,
              metadata: body.metadata,
            });
            await enqueueRun(runId);
            return { runId };
          } catch (err) {
            // Workflows that declare a `dedupKey` use a partial unique
            // index to enforce singleton semantics; a duplicate trips
            // Postgres 23505 here. Surface that as 409 so callers can
            // distinguish "already running / already done" from a real
            // 4xx — the raw constraint name is unhelpful to clients.
            if (isUniqueViolation(err)) {
              return status(409, {
                message: `An active run for workflow "${body.workflowSlug}" already exists.`,
              });
            }
            const msg = err instanceof Error ? err.message : String(err);
            return status(400, { message: msg });
          }
        },
        {
          body: t.Object({
            workflowSlug: t.String({ minLength: 1, maxLength: 120 }),
            brief: t.Optional(t.String({ maxLength: 4_000 })),
            input: t.Optional(t.Unknown()),
            metadata: t.Optional(t.Record(t.String(), t.Unknown())),
          }),
        },
      )
      .get(
        "/runs/:runId",
        async ({ params, user }) => {
          const run = await getRun(params.runId, user.id);
          if (!run) return status(404, { message: "Run not found" });
          return run;
        },
        { params: t.Object({ runId: t.String() }) },
      )
      .post(
        "/runs/:runId/signal",
        async ({ params, body, user }) => {
          const run = await getRun(params.runId, user.id);
          if (!run) return status(404, { message: "Run not found" });
          const woken = await signalRun({
            runId: params.runId,
            match: body.match,
          });
          if (!woken) return status(409, { message: "Run not waiting on a matching condition" });
          await enqueueRun(params.runId);
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

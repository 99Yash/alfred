import { Elysia, t } from "elysia";
import { authMacro } from "./middleware/auth";
import {
  isInternalWorkflowSlug,
  startRun,
  getRun,
  replayRun,
  redeliverRun,
  signalRun,
  listPublicWorkflows,
} from "@alfred/assistant/execution";
import type { SignalArgs } from "@alfred/assistant/execution";
import { isUniqueViolation } from "@alfred/db/pg-errors";
import { Errors, toMessage } from "@alfred/contracts";

export const agent = new Elysia({ prefix: "/api/agent", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
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
              // /api/agent/runs is the generic "Run now" surface. Cron
              // and event dispatchers go through their own paths; an
              // HTTP-initiated run is always manual per ADR-0027.
              trigger: { kind: "manual" },
              occurrence: {
                kind: "manual",
                requestId: body.requestId,
              },
            });
            return { runId };
          } catch (err) {
            // Workflows that declare a `dedupKey` use a partial unique
            // index to enforce singleton semantics; a duplicate trips
            // Postgres 23505 here. Surface that as 409 so callers can
            // distinguish "already running / already done" from a real
            // 4xx — the raw constraint name is unhelpful to clients.
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
          // Reshape the flat body into the discriminated union that
          // `signalRun` consumes. `kind` is `t.String()` rather than a
          // literal-union because Elysia 1.4's `exact-mirror` validator
          // logs a noisy warning the first time it sees ANY `t.Union`
          // schema (even of literals) and falls through without
          // enforcing it — same end state, less log noise. The handler
          // narrows + validates instead.
          let match: SignalArgs["match"];
          if (body.match) {
            const kind = body.match.kind;
            if (kind === "hil") {
              if (!body.match.approvalId) {
                throw Errors.BadRequestError("match.kind='hil' requires approvalId");
              }
              match = {
                kind: "hil",
                approvalId: body.match.approvalId,
                ...(body.match.approvalKind === "step" ||
                body.match.approvalKind === "action_staging"
                  ? { approvalKind: body.match.approvalKind }
                  : {}),
              };
            } else if (kind === "signal") {
              if (!body.match.name) {
                throw Errors.BadRequestError("match.kind='signal' requires name");
              }
              match = { kind: "signal", name: body.match.name };
            } else if (kind === "any") {
              match = { kind: "any" };
            } else {
              throw Errors.BadRequestError(
                `match.kind must be 'hil' | 'signal' | 'any'; got ${String(kind)}`,
              );
            }
          }
          const woken = await signalRun({ runId: params.runId, match });
          if (!woken) throw Errors.ConflictError("Run not waiting on a matching condition");
          await redeliverRun(params.runId);
          return { ok: true };
        },
        {
          params: t.Object({ runId: t.String() }),
          body: t.Object({
            match: t.Optional(
              t.Object({
                kind: t.String({ minLength: 1, maxLength: 16 }),
                approvalId: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
                approvalKind: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
                name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
              }),
            ),
          }),
        },
      ),
  );

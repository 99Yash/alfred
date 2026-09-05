import { Errors, toJsonValue } from "@alfred/contracts";
import { Elysia, t } from "elysia";

import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";
import {
  InvalidRunHistoryCursorError,
  listWorkflowRunHistory,
  recoverWorkflowDraft,
  workflowRecoveryNavigation,
} from "@alfred/assistant/automation";

/**
 * Workflow detail transports: the revalidation boundary used after
 * connect/reauthorize returns to a blocked draft, and the run history page the
 * detail page's History tab reads (#561).
 */
export const workflowRoutes = new Elysia({ prefix: "/api/workflows", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .get(
        "/:id/runs",
        async ({ user, params, query }) => {
          try {
            const history = await listWorkflowRunHistory({
              userId: user.id,
              workflowId: params.id,
              cursor: query.cursor,
              limit: query.limit,
            });
            if (!history) throw Errors.NotFoundError("Workflow not found");
            return history;
          } catch (err) {
            if (err instanceof InvalidRunHistoryCursorError) {
              throw Errors.BadRequestError(err.message);
            }
            throw err;
          }
        },
        {
          params: t.Object({ id: t.String({ minLength: 1, maxLength: 200 }) }),
          query: t.Object({
            cursor: t.Optional(t.String({ minLength: 1, maxLength: 400 })),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
          }),
        },
      )
      .post(
        "/:id/recovery",
        async ({ user, params, query }) => {
          const result = await recoverWorkflowDraft({
            userId: user.id,
            workflowId: params.id,
            revisionId: query.revisionId,
          });
          if (!result.ok) return result;
          if (!result.activationProposal) {
            const recovery = workflowRecoveryNavigation({
              workflowId: result.workflow.id,
              revisionId: result.revision.id,
              readiness: result.readiness,
            });
            return {
              ok: true as const,
              status: "blocked" as const,
              workflowId: result.workflow.id,
              revisionId: result.revision.id,
              readiness: result.readiness,
              ...(recovery ? { recovery } : {}),
            };
          }
          return {
            ok: true as const,
            status: "ready_to_activate" as const,
            workflowId: result.workflow.id,
            revisionId: result.revision.id,
            activationProposal: toJsonValue(result.activationProposal),
          };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1, maxLength: 200 }) }),
          query: t.Object({ revisionId: t.String({ minLength: 1, maxLength: 200 }) }),
        },
      ),
  );

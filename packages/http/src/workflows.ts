import { toJsonValue } from "@alfred/contracts";
import { Elysia, t } from "elysia";

// The sibling relative path, not the `@alfred/http` package specifier: that
// specifier resolves to this package's own `src/index.ts`, which re-exports
// this file, so it would make `index.ts -> workflows.ts -> index.ts` a module
// cycle inside the package. The package form compiles, passes every gate and
// boots — it survives only because `index.ts` exports the middleware before
// the routes, and reordering those lines turns it into a TDZ `ReferenceError`.
// Campaign item 21 owns the lint fence that makes it a compile error instead.
import { authMacro } from "./middleware/auth";
import { recoverWorkflowDraft, workflowRecoveryNavigation } from "@alfred/assistant/automation";

/** Revalidation boundary used after connect/reauthorize returns to a blocked draft. */
export const workflowRoutes = new Elysia({ prefix: "/api/workflows", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app.post(
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

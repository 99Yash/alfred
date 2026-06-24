import { toMessage } from "@alfred/contracts";
import { railwayValidateToken } from "@alfred/integrations/railway";
import {
  deleteIntegrationCredential,
  listBearerCredentials,
  upsertBearerCredential,
} from "@alfred/integrations/shared";
import { Elysia, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { BadRequestError, NotFoundError } from "../../middleware/errors";

/**
 * Railway integration routes. Railway has no public OAuth, so the user pastes
 * an API token (https://railway.com/account/tokens) — either an account token
 * or a workspace-scoped one. We validate it against the GraphQL API before
 * storing it via the shared bearer-credential layer — a bad token is rejected
 * at connect, not at first tool call.
 *
 *   POST   /api/integrations/railway/connect      { token }  → validate + store
 *   GET    /api/integrations/railway/credentials              → list connections
 *   DELETE /api/integrations/railway/:id                      → disconnect
 */
export const railwayIntegrationRoutes = new Elysia({
  prefix: "/api/integrations/railway",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .post(
        "/connect",
        async ({ user, body }) => {
          const token = body.token.trim();
          if (!token) throw new BadRequestError("Missing token");
          let account: Awaited<ReturnType<typeof railwayValidateToken>>;
          try {
            account = await railwayValidateToken(token);
          } catch (err) {
            // Log the real (redacted, bounded) upstream reason so prod failures
            // are diagnosable, but don't leak it to the client — a 401/403 just
            // means the pasted token is wrong or lacks API access.
            console.error(`[railway.connect] token validation failed :: ${toMessage(err)}`);
            throw new BadRequestError("Railway rejected that token — check it and try again");
          }
          const label = account.name ?? account.email ?? account.id;
          const credential = await upsertBearerCredential({
            userId: user.id,
            provider: "railway",
            accountId: account.id,
            accountLabel: label,
            accessToken: token,
            metadata: { name: account.name, email: account.email },
          });
          return { id: credential.id, accountLabel: label };
        },
        {
          body: t.Object({ token: t.String({ minLength: 1, maxLength: 4000 }) }),
        },
      )
      .get("/credentials", async ({ user }) => {
        const credentials = await listBearerCredentials(user.id, "railway");
        return { credentials };
      })
      .delete(
        "/:id",
        async ({ params, user }) => {
          const deleted = await deleteIntegrationCredential({
            userId: user.id,
            provider: "railway",
            id: params.id,
          });
          if (!deleted) throw new NotFoundError("Credential not found");
          return { id: deleted.id, ok: true };
        },
        { params: t.Object({ id: t.String() }) },
      ),
  );

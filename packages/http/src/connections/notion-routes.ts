import { Errors, integrationRoutePrefix, type CredentialProvider } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import {
  buildNotionAuthorizeUrl,
  exchangeNotionCode,
  isNotionConfigured,
} from "@alfred/integrations/notion";
import { deleteIntegrationCredential, upsertBearerCredential } from "@alfred/integrations/shared";
import { Elysia, t } from "elysia";
import { oauthHandshake } from "@alfred/assistant/connections";
import { authMacro } from "../middleware/auth";
import { requireOnboarded } from "../middleware/onboarding";

/** Notion OAuth with the same state-nonce check as Google. Tokens are long-lived bearers. */
const PROVIDER = "notion" satisfies CredentialProvider;

const handshake = oauthHandshake(PROVIDER);

export const notionIntegrationRoutes = new Elysia({
  prefix: integrationRoutePrefix(PROVIDER),
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .get("/connect", async ({ user, set }) => {
        if (!isNotionConfigured()) {
          throw Errors.ServiceUnavailableError("Notion integration is not configured");
        }

        const state = await handshake.begin({ userId: user.id });
        set.status = 302;
        set.headers["Location"] = buildNotionAuthorizeUrl(state);

        return null;
      })
      .delete(
        "/:id",
        async ({ params, user }) => {
          const deleted = await deleteIntegrationCredential({
            userId: user.id,
            provider: PROVIDER,
            id: params.id,
          });

          if (!deleted) throw Errors.NotFoundError("Credential not found");

          return { id: deleted.id, ok: true };
        },
        { params: t.Object({ id: t.String() }) },
      ),
  )
  // No session here; the signed state proves who started the flow.
  .get(
    "/callback",
    async ({ query, set }) => {
      const origin = serverEnv().CORS_ORIGIN;

      if (query.error) {
        set.status = 302;
        set.headers["Location"] =
          `${origin}/integrations?notion_error=${encodeURIComponent(query.error)}`;

        return null;
      }

      if (!query.code || !query.state) throw Errors.BadRequestError("Missing code or state");

      const { userId } = await handshake.complete(query.state);
      const tokens = await exchangeNotionCode(query.code);
      await upsertBearerCredential({
        userId,
        provider: PROVIDER,
        accountId: tokens.workspaceId,
        accountLabel: tokens.workspaceName ?? tokens.ownerName,
        accessToken: tokens.accessToken,
        metadata: {
          workspace_id: tokens.workspaceId,
          workspace_name: tokens.workspaceName,
          workspace_icon: tokens.workspaceIcon,
          bot_id: tokens.botId,
          owner_name: tokens.ownerName,
        },
      });

      const label = tokens.workspaceName ?? tokens.ownerName ?? tokens.workspaceId;
      set.status = 302;
      set.headers["Location"] =
        `${origin}/integrations?notion_connected=${encodeURIComponent(label)}`;

      return null;
    },
    {
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  );

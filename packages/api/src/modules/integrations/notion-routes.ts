import { serverEnv } from "@alfred/env/server";
import {
  buildNotionAuthorizeUrl,
  exchangeNotionCode,
  isNotionConfigured,
} from "@alfred/integrations/notion";
import {
  deleteIntegrationCredential,
  listBearerCredentials,
  upsertBearerCredential,
} from "@alfred/integrations/shared";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../../middleware/errors";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";

/**
 * Notion OAuth routes (full authorization-code flow). Same state-nonce CSRF
 * defense as Google/GitHub. Notion access tokens are long-lived, so the stored
 * credential is a plain bearer token via the shared bearer-credential layer.
 *
 *   GET    /api/integrations/notion/connect     → 302 to Notion's authorize URL
 *   GET    /api/integrations/notion/callback     ← Notion redirects with code + state
 *   GET    /api/integrations/notion/credentials  → list this user's connections
 *   DELETE /api/integrations/notion/:id          → disconnect
 */
export const notionIntegrationRoutes = new Elysia({
  prefix: "/api/integrations/notion",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/connect", async ({ user, set }) => {
        if (!isNotionConfigured()) {
          throw new ServiceUnavailableError("Notion integration is not configured");
        }
        const nonce = randomBytes(16).toString("hex");
        await rememberOAuthNonce({ provider: "notion", nonce, userId: user.id });
        const state = signOAuthState({ userId: user.id, nonce });
        set.status = 302;
        set.headers["Location"] = buildNotionAuthorizeUrl(state);
        return null;
      })
      .get("/credentials", async ({ user }) => {
        const credentials = await listBearerCredentials(user.id, "notion");
        return { credentials };
      })
      .delete(
        "/:id",
        async ({ params, user }) => {
          const deleted = await deleteIntegrationCredential({
            userId: user.id,
            provider: "notion",
            id: params.id,
          });
          if (!deleted) throw new NotFoundError("Credential not found");
          return { id: deleted.id, ok: true };
        },
        { params: t.Object({ id: t.String() }) },
      ),
  )
  // Callback is unauthenticated; the signed state proves who initiated.
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
      if (!query.code || !query.state) throw new BadRequestError("Missing code or state");

      const decoded = verifyOAuthState(query.state);
      if (!decoded) throw new BadRequestError("Invalid state");
      const storedUserId = await consumeOAuthNonce("notion", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        throw new BadRequestError("Invalid or expired state");
      }

      const tokens = await exchangeNotionCode(query.code);
      await upsertBearerCredential({
        userId: decoded.userId,
        provider: "notion",
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

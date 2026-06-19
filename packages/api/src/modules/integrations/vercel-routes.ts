import { serverEnv } from "@alfred/env/server";
import {
  buildVercelInstallUrl,
  exchangeVercelCode,
  isVercelConfigured,
} from "@alfred/integrations/vercel";
import { listBearerCredentials, upsertBearerCredential } from "@alfred/integrations/shared";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { BadRequestError, ServiceUnavailableError } from "../../middleware/errors";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";

/**
 * Vercel integration OAuth routes. The connect step sends the user to the
 * integration install URL; Vercel redirects back with a `code` (plus
 * `teamId`/`configurationId` for team installs) which we exchange for a
 * non-expiring access token, stored via the shared bearer-credential layer.
 *
 *   GET /api/integrations/vercel/connect     → 302 to the Vercel install URL
 *   GET /api/integrations/vercel/callback     ← Vercel redirects with code + state
 *   GET /api/integrations/vercel/credentials  → list this user's connections
 */
export const vercelIntegrationRoutes = new Elysia({
  prefix: "/api/integrations/vercel",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/connect", async ({ user, set }) => {
        if (!isVercelConfigured()) {
          throw new ServiceUnavailableError("Vercel integration is not configured");
        }
        const nonce = randomBytes(16).toString("hex");
        await rememberOAuthNonce({ provider: "vercel", nonce, userId: user.id });
        const state = signOAuthState({ userId: user.id, nonce });
        set.status = 302;
        set.headers["Location"] = buildVercelInstallUrl(state);
        return null;
      })
      .get("/credentials", async ({ user }) => {
        const credentials = await listBearerCredentials(user.id, "vercel");
        return { credentials };
      }),
  )
  .get(
    "/callback",
    async ({ query, set }) => {
      const origin = serverEnv().CORS_ORIGIN;
      if (query.error) {
        set.status = 302;
        set.headers["Location"] =
          `${origin}/integrations?vercel_error=${encodeURIComponent(query.error)}`;
        return null;
      }
      if (!query.code || !query.state) throw new BadRequestError("Missing code or state");

      const decoded = verifyOAuthState(query.state);
      if (!decoded) throw new BadRequestError("Invalid state");
      const storedUserId = await consumeOAuthNonce("vercel", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        throw new BadRequestError("Invalid or expired state");
      }

      const tokens = await exchangeVercelCode(query.code);
      // Personal installs have no team; key on the team id when present so a
      // team install and a personal install are distinct credential rows.
      const accountId = tokens.teamId ?? tokens.userId ?? tokens.installationId ?? "vercel";
      const label = tokens.teamId ? `team ${tokens.teamId}` : (tokens.userId ?? accountId);
      await upsertBearerCredential({
        userId: decoded.userId,
        provider: "vercel",
        accountId,
        accountLabel: label,
        accessToken: tokens.accessToken,
        metadata: {
          installation_id: tokens.installationId,
          configuration_id: query.configurationId ?? null,
          team_id: tokens.teamId,
          user_id: tokens.userId,
        },
      });

      set.status = 302;
      set.headers["Location"] =
        `${origin}/integrations?vercel_connected=${encodeURIComponent(label)}`;
      return null;
    },
    {
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        configurationId: t.Optional(t.String()),
        teamId: t.Optional(t.String()),
        next: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  );

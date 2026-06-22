import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildInstallUrl,
  canUserAccessInstallation,
  exchangeUserCode,
  upsertGithubCredential,
} from "@alfred/integrations/github";
import { deleteIntegrationCredential } from "@alfred/integrations/shared";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { authMacro } from "../../middleware/auth";
import { BadRequestError, NotFoundError } from "../../middleware/errors";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";

/**
 * GitHub App integration routes (ADR-0052). Same state-nonce CSRF defense as
 * `google-routes.ts`, but the IdP step is a GitHub App *install* rather than a
 * classic OAuth authorize. Because the App is registered with
 * `request_oauth_on_install`, a single install screen both installs the App
 * (giving us an `installation_id` + activity webhooks) and authorizes the user
 * (giving us a user-to-server `code` for identity) — one click, zero post-auth
 * setup.
 *
 *   GET    /api/integrations/github/connect      → 302 to the App install URL
 *   GET    /api/integrations/github/callback      ← GitHub redirects with code + installation_id
 *   GET    /api/integrations/github/credentials   → list this user's connections
 *   DELETE /api/integrations/github/:id           → disconnect (drops our token, App stays installed)
 */

export const githubIntegrationRoutes = new Elysia({
  prefix: "/api/integrations/github",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/connect", async ({ user, set }) => {
        const nonce = randomBytes(16).toString("hex");
        await rememberOAuthNonce({ provider: "github", nonce, userId: user.id });
        const state = signOAuthState({ userId: user.id, nonce });
        set.status = 302;
        set.headers["Location"] = buildInstallUrl(state);
        return null;
      })
      .get("/credentials", async ({ user }) => {
        const rows = await db()
          .select({
            id: integrationCredentials.id,
            accountId: integrationCredentials.accountId,
            accountLabel: integrationCredentials.accountLabel,
            status: integrationCredentials.status,
            scopes: integrationCredentials.scopes,
            // Surfaced so the web client can nag legacy classic-OAuth rows
            // (no installation_id) to reconnect under the GitHub App.
            installationId: integrationCredentials.installationId,
            expiresAt: integrationCredentials.expiresAt,
            lastRefreshedAt: integrationCredentials.lastRefreshedAt,
            createdAt: integrationCredentials.createdAt,
          })
          .from(integrationCredentials)
          .where(
            and(
              eq(integrationCredentials.userId, user.id),
              eq(integrationCredentials.provider, "github"),
            ),
          );
        return { credentials: rows };
      })
      .delete(
        "/:id",
        async ({ params, user }) => {
          // Drops our stored token + installation reference. The GitHub App
          // itself stays installed on the user's account until they remove it
          // from GitHub's settings — we just stop holding credentials for it.
          const deleted = await deleteIntegrationCredential({
            userId: user.id,
            provider: "github",
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

      // Install initiated directly from the App's GitHub page (no state) —
      // we can't bind it to an Alfred user, so drop them on /integrations to
      // connect properly from inside the app.
      if (!query.state) {
        set.status = 302;
        set.headers["Location"] = `${origin}/integrations`;
        return null;
      }

      const decoded = verifyOAuthState(query.state);
      if (!decoded) throw new BadRequestError("Invalid state");

      const storedUserId = await consumeOAuthNonce("github", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        throw new BadRequestError("Invalid or expired state");
      }
      if (!query.code) throw new BadRequestError("Missing code");
      if (!query.installation_id) throw new BadRequestError("Missing installation_id");

      const tokens = await exchangeUserCode(query.code);
      const installationId = query.installation_id;
      const installationMatchesUser = await canUserAccessInstallation({
        accessToken: tokens.accessToken,
        installationId,
      });
      if (!installationMatchesUser) {
        throw new BadRequestError("GitHub installation is not accessible to this user");
      }

      // Onboarding lookup is independent of the credential upsert — race them.
      const [credential, userRow] = await Promise.all([
        upsertGithubCredential({
          userId: decoded.userId,
          accountId: tokens.accountId,
          accountLabel: tokens.accountLogin,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          installationId,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          metadata: {
            login: tokens.accountLogin,
            name: tokens.accountName,
            email: tokens.accountEmail,
            token_type: tokens.tokenType,
            installation_id: installationId,
            setup_action: query.setup_action ?? null,
          },
        }),
        db()
          .select({ onboardedAt: user.onboardedAt })
          .from(user)
          .where(eq(user.id, decoded.userId))
          .limit(1),
      ]);

      const stillOnboarding = userRow[0]?.onboardedAt === null;
      const connectedParam = `github_connected=${encodeURIComponent(tokens.accountLogin)}`;
      const target = stillOnboarding
        ? `/onboarding?step=2&${connectedParam}`
        : `/integrations?${connectedParam}`;
      set.status = 302;
      set.headers["Location"] = `${origin}${target}`;
      // Returning the credential id is only useful in tests; the browser
      // follows the Location redirect immediately.
      return { id: credential.id };
    },
    {
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        installation_id: t.Optional(t.String()),
        setup_action: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  );

import { Errors, integrationRoutePrefix, type CredentialProvider } from "@alfred/contracts";
import { db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildInstallUrl,
  canUserAccessInstallation,
  exchangeUserCode,
  getInstallation,
  upsertGithubCredential,
} from "@alfred/integrations/github";
import { deleteIntegrationCredential } from "@alfred/integrations/shared";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "@alfred/assistant/connections";
import { authMacro } from "../middleware/auth";
import { requireOnboarded } from "../middleware/onboarding";

/**
 * GitHub App connect (ADR-0052). With `request_oauth_on_install`, one install
 * screen gives both an `installation_id` and a user `code`.
 * Same state-nonce CSRF check as `google-routes.ts`.
 */

const PROVIDER = "github" satisfies CredentialProvider;

export const githubIntegrationRoutes = new Elysia({
  prefix: integrationRoutePrefix(PROVIDER),
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  // No `requireOnboarded`: onboarding step 2 links here.
  .guard({ auth: true }, (app) =>
    app.get("/connect", async ({ user, set }) => {
      const nonce = randomBytes(16).toString("hex");
      await rememberOAuthNonce({ provider: PROVIDER, nonce, userId: user.id });
      const state = signOAuthState({ userId: user.id, nonce });
      set.status = 302;
      set.headers["Location"] = buildInstallUrl(state);

      return null;
    }),
  )
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app.delete(
      "/:id",
      async ({ params, user }) => {
        // The App stays installed on GitHub; we only drop our credentials.
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
  // Callback is unauthenticated; the signed state proves who initiated.
  .get(
    "/callback",
    async ({ query, set }) => {
      const origin = serverEnv().CORS_ORIGIN;

      // An install from GitHub's own page has no state, so no Alfred user to bind.
      if (!query.state) {
        set.status = 302;
        set.headers["Location"] = `${origin}/integrations`;

        return null;
      }

      const decoded = verifyOAuthState(query.state);

      if (!decoded) throw Errors.BadRequestError("Invalid state");

      const storedUserId = await consumeOAuthNonce(PROVIDER, decoded.nonce);

      if (!storedUserId || storedUserId !== decoded.userId) {
        throw Errors.BadRequestError("Invalid or expired state");
      }

      if (!query.installation_id) throw Errors.BadRequestError("Missing installation_id");
      const installationId = query.installation_id;

      // `setup_action=update` sends no `code`. Then we look up the installation with the
      // App JWT, so a lost Alfred row does not force a reinstall.
      let accountId: string;
      let accountLogin: string;
      let accountEmail: string | null = null;
      let accountName: string | null = null;
      let accessToken: string;
      let refreshToken: string | null = null;
      let expiresAt: Date;
      let scopes: string[] = [];
      let tokenType = "bearer";

      if (query.code) {
        const tokens = await exchangeUserCode(query.code);

        const installationMatchesUser = await canUserAccessInstallation({
          accessToken: tokens.accessToken,
          installationId,
        });

        if (!installationMatchesUser) {
          throw Errors.BadRequestError("GitHub installation is not accessible to this user");
        }

        accountId = tokens.accountId;
        accountLogin = tokens.accountLogin;
        accountEmail = tokens.accountEmail;
        accountName = tokens.accountName;
        accessToken = tokens.accessToken;
        refreshToken = tokens.refreshToken;
        expiresAt = tokens.expiresAt;
        scopes = tokens.scopes;
        tokenType = tokens.tokenType;
      } else {
        const inst = await getInstallation(installationId);

        if (!inst) throw Errors.BadRequestError("GitHub installation not found");
        accountId = inst.accountId;
        accountLogin = inst.accountLogin;
        // The row needs a token, but REST uses `getInstallationToken`. Far-future expiry
        // avoids an instant `needs_reauth`.
        accessToken = `ghu_placeholder_${installationId}`;
        expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      }

      const [credential, userRow] = await Promise.all([
        upsertGithubCredential({
          userId: decoded.userId,
          accountId,
          accountLabel: accountLogin,
          accessToken,
          refreshToken,
          installationId,
          expiresAt,
          scopes,
          metadata: {
            login: accountLogin,
            name: accountName,
            email: accountEmail,
            token_type: tokenType,
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
      const connectedParam = `github_connected=${encodeURIComponent(accountLogin)}`;

      const target = stillOnboarding
        ? `/onboarding?step=2&${connectedParam}`
        : `/integrations?${connectedParam}`;

      set.status = 302;
      set.headers["Location"] = `${origin}${target}`;

      // For tests; the browser follows the redirect.
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

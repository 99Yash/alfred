import {
  Errors,
  integrationRoutePrefix,
  mcpBuiltInConnectPath,
  type CredentialProvider,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { logger } from "@alfred/logging";
import {
  buildInstallUrl,
  buildUserAuthorizeUrl,
  canUserAccessInstallation,
  exchangeUserCode,
  findUserInstallation,
  getInstallation,
  hasPersonalInstallation,
  upsertGithubCredential,
  userTokenExpiresAt,
} from "@alfred/integrations/github";
import { deleteIntegrationCredential } from "@alfred/integrations/shared";
import { Elysia, t } from "elysia";
import { oauthHandshake } from "@alfred/assistant/connections";
import { adoptGithubAppGrant, type GithubAppUserGrant } from "@alfred/assistant/connections/mcp";
import { authMacro } from "../middleware/auth";
import { readOnboarding, requireOnboarded } from "../middleware/onboarding";

/**
 * GitHub App connect (ADR-0052). With `request_oauth_on_install`, one install
 * screen gives both an `installation_id` and a user `code`. The code's grant also
 * connects the GitHub MCP, which uses the same App client (ADR-0093, 2026-11-12).
 * Same state-nonce CSRF check as `google-routes.ts`.
 */

const PROVIDER = "github" satisfies CredentialProvider;

/**
 * One GitHub screen on connect. GitHub, not the Alfred rows, tells if the App is installed,
 * because an Alfred disconnect keeps the App installed. With no personal installation, the
 * install screen also authorizes the user (`request_oauth_on_install`). With one, the user
 * authorization shows one screen, or none when the user authorized the App before.
 */
async function connectUrl(state: string): Promise<string> {
  try {
    return (await hasPersonalInstallation())
      ? buildUserAuthorizeUrl(state)
      : buildInstallUrl(state);
  } catch (err) {
    // If GitHub does not answer, use the user authorization. The install page never comes
    // back when the App is installed, so a wrong guess there is a dead end. A wrong guess
    // here costs one more screen: the callback finds no installation and sends the user on.
    logger.warn({ err }, "[github.connect] installation check failed; using user authorization");

    return buildUserAuthorizeUrl(state);
  }
}

const handshake = oauthHandshake(PROVIDER);

export const githubIntegrationRoutes = new Elysia({
  prefix: integrationRoutePrefix(PROVIDER),
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  // No `requireOnboarded`: onboarding step 2 links here.
  .guard({ auth: true }, (app) =>
    app.get("/connect", async ({ user, set }) => {
      const state = await handshake.begin({ userId: user.id });

      set.status = 302;
      set.headers["Location"] = await connectUrl(state);

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

      // Consume the nonce first, so a refusal also spends the state.
      const { userId } = await handshake.complete(query.state);

      // The user refused the authorization (`access_denied`). The web app shows the error.
      if (query.error) {
        const errorParam = `github_error=${encodeURIComponent(query.error)}`;
        const userRow = await readOnboarding(userId);

        set.status = 302;
        set.headers["Location"] =
          userRow?.onboardedAt === null
            ? `${origin}/onboarding?step=2&${errorParam}`
            : `${origin}/integrations?${errorParam}`;

        return null;
      }

      // `setup_action=update` sends no `code`. Then we look up the installation with the
      // App JWT, so a lost Alfred row does not force a reinstall.
      // The user authorization from `/connect` sends a `code` and no `installation_id`.
      let installationId: string;
      let accountId: string;
      let accountLogin: string;
      let accountEmail: string | null = null;
      let accountName: string | null = null;
      let accessToken: string;
      let expiresAt: Date;
      let scopes: string[] = [];
      let tokenType = "bearer";
      // The App user grant from this install. The GitHub MCP connection takes it.
      let grant: GithubAppUserGrant | null = null;

      if (query.code) {
        const tokens = await exchangeUserCode(query.code);

        if (query.installation_id) {
          const installationMatchesUser = await canUserAccessInstallation({
            accessToken: tokens.accessToken,
            installationId: query.installation_id,
          });

          if (!installationMatchesUser) {
            throw Errors.BadRequestError("GitHub installation is not accessible to this user");
          }

          installationId = query.installation_id;
        } else {
          const found = await findUserInstallation({
            accessToken: tokens.accessToken,
            accountId: tokens.accountId,
          });

          // Authorized, but the App is not on the user's own account: install it. That screen
          // comes back with both. `/connect` sends a user here only when the App is on another
          // personal account, or when its installation check failed.
          if (!found) {
            set.status = 302;
            set.headers["Location"] = buildInstallUrl(await handshake.begin({ userId }));

            return null;
          }

          installationId = found;
        }

        accountId = tokens.accountId;
        accountLogin = tokens.accountLogin;
        accountEmail = tokens.accountEmail;
        accountName = tokens.accountName;
        accessToken = tokens.accessToken;
        expiresAt = userTokenExpiresAt(tokens.expiresInSeconds);
        scopes = tokens.scopes;
        tokenType = tokens.tokenType;
        grant = tokens;
      } else {
        if (!query.installation_id) throw Errors.BadRequestError("Missing installation_id");
        installationId = query.installation_id;
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
          userId,
          accountId,
          accountLabel: accountLogin,
          accessToken,
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
        readOnboarding(userId),
      ]);

      const stillOnboarding = userRow?.onboardedAt === null;
      const connectedParam = `github_connected=${encodeURIComponent(accountLogin)}`;

      // The same App grant connects the GitHub MCP. A failure goes on the MCP row, not here.
      if (grant) await adoptGithubAppGrant({ userId, grant });

      const target = stillOnboarding
        ? `${origin}/onboarding?step=2&${connectedParam}`
        : grant
          ? `${origin}/integrations?${connectedParam}`
          : // No `code` (`setup_action=update`): the MCP consent uses the same App, so
            // GitHub shows no second screen. That route needs onboarding, so skip it there.
            // It is an API route, so it goes on the API origin (`BETTER_AUTH_URL`).
            `${serverEnv().BETTER_AUTH_URL.replace(/\/$/, "")}${mcpBuiltInConnectPath("github")}`;

      set.status = 302;
      set.headers["Location"] = target;

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

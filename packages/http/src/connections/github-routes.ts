import {
  assertNever,
  builtInMCPConnectPath,
  Errors,
  integrationRoutePrefix,
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
  listGithubCredentials,
  upsertGithubCredential,
  userTokenExpiresAt,
} from "@alfred/integrations/github";
import { deleteIntegrationCredential } from "@alfred/integrations/shared";
import { Elysia, t } from "elysia";
import { oauthHandshake } from "@alfred/assistant/connections";
import {
  adoptGithubAppGrant,
  detachGithubAppGrant,
  type GithubAppGrantOutcome,
  type GithubAppUserGrant,
} from "@alfred/assistant/connections/mcp";
import { authMacro } from "../middleware/auth";
import { readOnboarding, requireOnboarded } from "../middleware/onboarding";

/**
 * GitHub App connect (ADR-0052). With `request_oauth_on_install`, one install
 * screen gives both an `installation_id` and a user `code`. The code's grant also
 * connects the GitHub MCP, which uses the same App client (ADR-0093, 2026-11-12).
 * Same state-nonce CSRF check as `google-routes.ts`.
 */

const PROVIDER = "github" satisfies CredentialProvider;

/** The GitHub and credential reads that pick an installation. A test passes its own. */
interface GithubInstallationReads {
  listGithubCredentials: typeof listGithubCredentials;
  hasPersonalInstallation: typeof hasPersonalInstallation;
  canUserAccessInstallation: typeof canUserAccessInstallation;
  findUserInstallation: typeof findUserInstallation;
}

const GITHUB_READS: GithubInstallationReads = {
  listGithubCredentials,
  hasPersonalInstallation,
  canUserAccessInstallation,
  findUserInstallation,
};

/**
 * One GitHub screen on connect. A stored installation goes to the user authorization: the
 * callback keeps that installation, and the install page never comes back for an installed App.
 * With no stored installation, GitHub tells if the App is installed, because an Alfred disconnect
 * keeps the App installed. With no personal installation, the install screen also authorizes the
 * user (`request_oauth_on_install`). With one, the user authorization shows one screen, or none
 * when the user authorized the App before.
 */
export async function connectUrl(
  userId: string,
  state: string,
  reads: Pick<
    GithubInstallationReads,
    "listGithubCredentials" | "hasPersonalInstallation"
  > = GITHUB_READS,
): Promise<string> {
  try {
    const credentials = await reads.listGithubCredentials(userId);

    if (credentials.some((credential) => credential.installationId !== null)) {
      return buildUserAuthorizeUrl(state);
    }

    return (await reads.hasPersonalInstallation())
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

/**
 * The installation for a callback with a `code` and no `installation_id`. The installation that
 * this account stored before stays while the user can still reach it: an org installation must
 * not change to a personal one on a renewed grant, or org webhooks lose their owner. Only the
 * install screen, which sends an explicit `installation_id`, switches it.
 */
export async function installationForGrant(
  input: {
    readonly userId: string;
    readonly accessToken: string;
    readonly accountId: string;
  },
  reads: Pick<
    GithubInstallationReads,
    "listGithubCredentials" | "canUserAccessInstallation" | "findUserInstallation"
  > = GITHUB_READS,
): Promise<string | null> {
  const stored = (await reads.listGithubCredentials(input.userId)).find(
    (credential) => credential.accountId === input.accountId,
  )?.installationId;

  if (
    stored &&
    (await reads.canUserAccessInstallation({
      accessToken: input.accessToken,
      installationId: stored,
    }))
  ) {
    return stored;
  }

  return reads.findUserInstallation({ accessToken: input.accessToken, accountId: input.accountId });
}

/** The GitHub MCP outcome on the redirect. The web app tells the owner when chat cannot read. */
function grantOutcomeParam(outcome: GithubAppGrantOutcome | null): string {
  if (outcome === null) return "";

  switch (outcome.outcome) {
    case "connected":
      return "";
    case "auth_required":
    case "failed":
      return `&github_mcp_error=${outcome.outcome}`;
    default:
      return assertNever(outcome, "GitHub App grant outcome");
  }
}

/**
 * Where the callback sends the browser. `grantOutcome` is `null` when the callback had no `code`,
 * so no grant went to the GitHub MCP.
 */
export function callbackTarget(input: {
  readonly stillOnboarding: boolean;
  readonly accountLogin: string;
  readonly grantOutcome: GithubAppGrantOutcome | null;
}): string {
  const env = serverEnv();
  const connectedParam = `github_connected=${encodeURIComponent(input.accountLogin)}`;
  const grantParam = grantOutcomeParam(input.grantOutcome);

  if (input.stillOnboarding) {
    return `${env.CORS_ORIGIN}/onboarding?step=2&${connectedParam}${grantParam}`;
  }

  if (input.grantOutcome !== null) {
    return `${env.CORS_ORIGIN}/integrations?${connectedParam}${grantParam}`;
  }

  // No `code` (`setup_action=update`): the GitHub connect authorizes the user, and that grant
  // opens the GitHub MCP. The App is already authorized, so GitHub shows no screen. It is an
  // API route, so it goes on the API origin (`BETTER_AUTH_URL`).
  return `${env.BETTER_AUTH_URL.replace(/\/$/, "")}${builtInMCPConnectPath("github")}`;
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
      set.headers["Location"] = await connectUrl(user.id, state);

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

        // One GitHub control: chat reads end too. The grant has no account on its row, so any
        // GitHub disconnect detaches it, and the next GitHub connect opens it again.
        await detachGithubAppGrant(user.id);

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
          const found = await installationForGrant({
            userId,
            accessToken: tokens.accessToken,
            accountId: tokens.accountId,
          });

          // Authorized, but no stored installation that the user can reach, and the App is not on
          // the user's own account: install it. That screen comes back with both.
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

      // The same App grant connects the GitHub MCP. Its failure does not fail the GitHub connect,
      // but the redirect names it, so the page shows it.
      const grantOutcome = grant ? await adoptGithubAppGrant({ userId, grant }) : null;

      set.status = 302;
      set.headers["Location"] = callbackTarget({
        stillOnboarding: userRow?.onboardedAt === null,
        accountLogin,
        grantOutcome,
      });

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

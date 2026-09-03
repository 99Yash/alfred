import {
  Errors,
  integrationRoutePrefix,
  rowToCredentialWire,
  type CredentialProvider,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
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
import { and, eq } from "drizzle-orm";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "@alfred/assistant/connections";
import { authMacro } from "../middleware/auth";
import { requireOnboarded } from "../middleware/onboarding";

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

const PROVIDER = "github" satisfies CredentialProvider;

export const githubIntegrationRoutes = new Elysia({
  prefix: integrationRoutePrefix(PROVIDER),
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  // `/connect` + `/credentials` must be reachable during onboarding
  // step 2 so the showcase truth-checks correctly.
  .guard({ auth: true }, (app) =>
    app
      .get("/credentials", async ({ user }) => {
        const rows = await db()
          .select({
            id: integrationCredentials.id,
            accountId: integrationCredentials.accountId,
            accountLabel: integrationCredentials.accountLabel,
            status: integrationCredentials.status,
            scopes: integrationCredentials.scopes,
            installationId: integrationCredentials.installationId,
            expiresAt: integrationCredentials.expiresAt,
            lastRefreshedAt: integrationCredentials.lastRefreshedAt,
            createdAt: integrationCredentials.createdAt,
          })
          .from(integrationCredentials)
          .where(
            and(
              eq(integrationCredentials.userId, user.id),
              eq(integrationCredentials.provider, PROVIDER),
            ),
          );
        return { credentials: rows.map(rowToCredentialWire) };
      })
      .get("/connect", async ({ user, set }) => {
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
        // Drops our stored token + installation reference. The GitHub App
        // itself stays installed on the user's account until they remove it
        // from GitHub's settings — we just stop holding credentials for it.
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

      // Install initiated directly from the App's GitHub page (no state) —
      // we can't bind it to an Alfred user, so drop them on /integrations to
      // connect properly from inside the app.
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

      // Normal path: GitHub sent both `code` (user-to-server OAuth) and
      // `installation_id` — exchange the code for identity and verify the
      // installation belongs to the caller.
      //
      // Already-installed path: the App is already on the account and the
      // user just re-configured it (setup_action=update). GitHub then
      // redirects with `installation_id` but NO `code`. We reconcile via the
      // App JWT instead, so deleting your Alfred row (DB wipe) doesn't force
      // you to uninstall/reinstall the GitHub App to get back in.
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
        // No code — fall back to App-JWT installation lookup. This still
        // proves the installation exists and yields the account, but we
        // mint a placeholder token that will be refreshed on next use via
        // the installation token flow. We use a sentinel far-future expiry
        // and empty scopes since the App permissions live on the
        // installation, not on OAuth scopes.
        const inst = await getInstallation(installationId);
        if (!inst) throw Errors.BadRequestError("GitHub installation not found");
        accountId = inst.accountId;
        accountLogin = inst.accountLogin;
        // Use a sealed sentinel token — the credential row requires one, but
        // live REST goes through `getInstallationToken(installationId)` so it
        // never uses this value. `expiresAt` is far-future so we don't trip
        // `needs_reauth` immediately.
        accessToken = `ghu_placeholder_${installationId}`;
        expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      }

      // Onboarding lookup is independent of the credential upsert — race them.
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

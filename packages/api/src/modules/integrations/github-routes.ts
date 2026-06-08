import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildInstallUrl,
  canUserAccessInstallation,
  exchangeUserCode,
  upsertGithubCredential,
} from "@alfred/integrations/github";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Elysia, status, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { authMacro } from "../../middleware/auth";
import { consumeOAuthNonce, rememberOAuthNonce } from "./oauth-state";

/**
 * GitHub App integration routes (ADR-0052). Same state-nonce CSRF defense as
 * `google-routes.ts`, but the IdP step is a GitHub App *install* rather than a
 * classic OAuth authorize. Because the App is registered with
 * `request_oauth_on_install`, a single install screen both installs the App
 * (giving us an `installation_id` + activity webhooks) and authorizes the user
 * (giving us a user-to-server `code` for identity) — one click, zero post-auth
 * setup.
 *
 *   GET  /api/integrations/github/connect      → 302 to the App install URL
 *   GET  /api/integrations/github/callback      ← GitHub redirects with code + installation_id
 *   GET  /api/integrations/github/credentials   → list this user's connections
 */

interface SignedState {
  userId: string;
  nonce: string;
}

function signState(state: SignedState): string {
  const env = serverEnv();
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyState(raw: string): SignedState | null {
  const env = serverEnv();
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SignedState;
  } catch {
    return null;
  }
}

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
        const state = signState({ userId: user.id, nonce });
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
      }),
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

      const decoded = verifyState(query.state);
      if (!decoded) return status(400, { message: "Invalid state" });

      const storedUserId = await consumeOAuthNonce("github", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        return status(400, { message: "Invalid or expired state" });
      }
      if (!query.code) return status(400, { message: "Missing code" });
      if (!query.installation_id) return status(400, { message: "Missing installation_id" });

      const tokens = await exchangeUserCode(query.code);
      const installationId = query.installation_id;
      const installationMatchesUser = await canUserAccessInstallation({
        accessToken: tokens.accessToken,
        installationId,
      });
      if (!installationMatchesUser) {
        return status(400, { message: "GitHub installation is not accessible to this user" });
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

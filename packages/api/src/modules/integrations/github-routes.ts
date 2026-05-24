import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildAuthorizeUrl,
  exchangeCode,
  GITHUB_FEATURE_SCOPES,
  type GithubFeature,
  scopesForFeatures,
  upsertGithubCredential,
} from "@alfred/integrations/github";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Elysia, status, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { authMacro } from "../../middleware/auth";
import { consumeOAuthNonce, rememberOAuthNonce } from "./oauth-state";

/**
 * GitHub integration routes. Same shape as `google-routes.ts` — different
 * IdP, identical state-nonce CSRF defense.
 *
 *   GET  /api/integrations/github/connect   → 302 to GitHub authorize URL
 *   GET  /api/integrations/github/callback ← GitHub redirects with `code`
 *   GET  /api/integrations/github/credentials → list this user's connections
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

export const githubIntegrationRoutes = new Elysia({ prefix: "/api/integrations/github" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get(
        "/connect",
        async ({ user, query, set }) => {
          let features: GithubFeature[] | undefined;
          if (query.features) {
            const parsed = query.features
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const known = parsed.filter((f): f is GithubFeature => f in GITHUB_FEATURE_SCOPES);
            if (known.length !== parsed.length) {
              return status(400, {
                message: `Unknown feature(s): ${parsed.filter((f) => !known.includes(f as GithubFeature)).join(", ")}`,
              });
            }
            features = known;
          }

          const nonce = randomBytes(16).toString("hex");
          await rememberOAuthNonce({ provider: "github", nonce, userId: user.id });
          const state = signState({ userId: user.id, nonce });
          const url = buildAuthorizeUrl({
            state,
            scopes: scopesForFeatures(features),
          });
          set.status = 302;
          set.headers["Location"] = url;
          return null;
        },
        {
          query: t.Object({
            features: t.Optional(t.String({ maxLength: 200 })),
          }),
        },
      )
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
      if (!query.code || !query.state) {
        return status(400, { message: "Missing code or state" });
      }
      const decoded = verifyState(query.state);
      if (!decoded) return status(400, { message: "Invalid state" });

      const storedUserId = await consumeOAuthNonce("github", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        return status(400, { message: "Invalid or expired state" });
      }

      const tokens = await exchangeCode(query.code);
      const credential = await upsertGithubCredential({
        userId: decoded.userId,
        accountId: tokens.accountId,
        accountLabel: tokens.accountLogin,
        accessToken: tokens.access_token,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        metadata: {
          login: tokens.accountLogin,
          name: tokens.accountName,
          email: tokens.accountEmail,
          token_type: tokens.token_type,
        },
      });

      // Bounce back to the SPA. If the user is mid-onboarding, return to
      // step 2; otherwise drop them on the integrations page so they can
      // see the new "Connected" badge.
      const userRow = await db()
        .select({ onboardedAt: user.onboardedAt })
        .from(user)
        .where(eq(user.id, decoded.userId))
        .limit(1);
      const stillOnboarding = userRow[0]?.onboardedAt === null;
      const connectedParam = `github_connected=${encodeURIComponent(tokens.accountLogin)}`;
      const target = stillOnboarding
        ? `/onboarding?step=2&${connectedParam}`
        : `/integrations?${connectedParam}`;
      set.status = 302;
      set.headers["Location"] = `${serverEnv().CORS_ORIGIN}${target}`;
      // Returning the credential id is only useful in tests; the
      // browser follows the Location redirect immediately.
      return { id: credential.id };
    },
    {
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  );

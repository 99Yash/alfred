import { db } from "@alfred/db";
import { integrationCredentials } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getGmailWatchState,
  installGmailWatch,
  uninstallGmailWatch,
  upsertCredential,
} from "@alfred/integrations/google";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Elysia, status, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { authMacro } from "../../middleware/auth";
import { getIngestionQueue } from "./queue";
import { consumeOAuthNonce, rememberOAuthNonce } from "./oauth-state";

/**
 * Google integration routes.
 *
 *   GET  /api/integrations/google/connect  → 302 to Google's authorize URL
 *   GET  /api/integrations/google/callback ← Google redirects here with `code`
 *   POST /api/integrations/google/:id/ingest → enqueue an ingestion job
 *
 * The `state` parameter on the authorize URL carries `(userId, nonce)`,
 * HMAC-signed with `BETTER_AUTH_SECRET` to detect tampering. The real
 * CSRF/replay defense is the nonce: we persist it in Redis with a TTL
 * and atomically consume it on callback, so a captured state can't be
 * reused.
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

export const googleIntegrationRoutes = new Elysia({ prefix: "/api/integrations/google" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get("/connect", async ({ user, set }) => {
        const nonce = randomBytes(16).toString("hex");
        await rememberOAuthNonce({ provider: "google", nonce, userId: user.id });
        const state = signState({ userId: user.id, nonce });
        const url = buildAuthorizeUrl({ state });
        set.status = 302;
        set.headers["Location"] = url;
        return null;
      })
      .get(
        "/credentials",
        async ({ user }) => {
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
                eq(integrationCredentials.provider, "google"),
              ),
            );
          return { credentials: rows };
        },
      )
      .post(
        "/:id/watch",
        async ({ params, user }) => {
          const owner = await db()
            .select({ id: integrationCredentials.id })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
              ),
            );
          if (!owner[0]) return status(404, { message: "Credential not found" });
          const topic = serverEnv().GOOGLE_PUBSUB_TOPIC;
          if (!topic) return status(503, { message: "GOOGLE_PUBSUB_TOPIC not configured" });
          const state = await installGmailWatch({ credentialId: params.id, topicName: topic });
          return { credentialId: params.id, watch: state };
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      .delete(
        "/:id/watch",
        async ({ params, user }) => {
          const owner = await db()
            .select({ id: integrationCredentials.id })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
              ),
            );
          if (!owner[0]) return status(404, { message: "Credential not found" });
          await uninstallGmailWatch(params.id);
          return { credentialId: params.id, ok: true };
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      .get(
        "/:id/watch",
        async ({ params, user }) => {
          const owner = await db()
            .select({ id: integrationCredentials.id })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
              ),
            );
          if (!owner[0]) return status(404, { message: "Credential not found" });
          const state = await getGmailWatchState(params.id);
          return { credentialId: params.id, watch: state };
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      .post(
        "/:id/ingest",
        async ({ params, body, user }) => {
          // Confirm the credential belongs to the caller before enqueueing —
          // otherwise an authenticated user could trigger ingestion against
          // someone else's credential id.
          const owner = await db()
            .select({ id: integrationCredentials.id })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
              ),
            );
          if (!owner[0]) return status(404, { message: "Credential not found" });

          const queue = getIngestionQueue();
          const job = await queue.add("gmail.ingest_recent", {
            kind: "gmail.ingest_recent",
            credentialId: params.id,
            query: body?.query,
            maxMessages: body?.maxMessages,
          });
          return { jobId: job.id, credentialId: params.id };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Optional(
            t.Object({
              query: t.Optional(t.String({ maxLength: 500 })),
              maxMessages: t.Optional(t.Integer({ minimum: 1, maximum: 5000 })),
            }),
          ),
        },
      ),
  )
  // Callback runs unauthenticated — the user is mid-OAuth-flow with Google,
  // not in our session yet (or in a different tab). The signed `state`
  // proves who initiated the flow without needing a session cookie.
  .get(
    "/callback",
    async ({ query, set }) => {
      if (!query.code || !query.state) {
        return status(400, { message: "Missing code or state" });
      }
      const decoded = verifyState(query.state);
      if (!decoded) return status(400, { message: "Invalid state" });

      // Atomically consume the nonce. If it's missing/expired/already used,
      // reject — this is what makes captured `state` values single-use.
      // We additionally require the persisted userId to match the one in
      // the signed state as a sanity check.
      const storedUserId = await consumeOAuthNonce("google", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        return status(400, { message: "Invalid or expired state" });
      }

      const tokens = await exchangeCode(query.code);
      await upsertCredential({
        userId: decoded.userId,
        provider: "google",
        accountId: tokens.accountId,
        accountLabel: tokens.accountEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token!,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        metadata: { token_type: tokens.token_type },
      });

      // Bounce back to the SPA. We don't have an "integrations" page yet;
      // land on the root with a query flag the UI can pick up.
      set.status = 302;
      set.headers["Location"] = `${serverEnv().CORS_ORIGIN}/?google_connected=${encodeURIComponent(tokens.accountEmail)}`;
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

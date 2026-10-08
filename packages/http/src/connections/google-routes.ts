import {
  ACCOUNT_PERSONAS,
  Errors,
  GOOGLE_FEATURE_SCOPES,
  integrationRoutePrefix,
  toMessage,
  type CredentialProvider,
  type GoogleFeature,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getGmailWatchState,
  assertGmailPushOidcConfigured,
  isGmailPushOidcConfigError,
  scopesForFeatures,
  uninstallGmailWatch,
} from "@alfred/integrations/google";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import {
  getIngestionQueue,
  installGmailWatchAndSeedCursor,
  resolveWorkflowRecoveryTarget,
} from "@alfred/assistant/connections/ingestion";
import {
  consumeOAuthNonce,
  disconnectGoogleCredentialConnection,
  GoogleCredentialNotFoundError,
  publishGoogleCallbackCompleted,
  rememberOAuthNonce,
  signOAuthState,
  upsertGoogleCredentialConnection,
  verifyOAuthState,
} from "@alfred/assistant/connections";
import { authMacro } from "../middleware/auth";
import { requireOnboarded } from "../middleware/onboarding";

/**
 * Google connect. `state` is HMAC-signed `(userId, nonce)`. The CSRF defense is the
 * Redis nonce, consumed once on callback.
 */

/** A post-callback failure must not send the user to an OAuth error page. */
async function bestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[google.callback] ${label}:`, toMessage(err));
  }
}

/** 404, not 403, so the response never confirms another user's id exists. */
async function assertCredentialOwned(id: string, userId: string): Promise<void> {
  const owner = await db()
    .select({ id: integrationCredentials.id })
    .from(integrationCredentials)
    .where(and(eq(integrationCredentials.id, id), eq(integrationCredentials.userId, userId)));

  if (!owner[0]) throw Errors.NotFoundError("Credential not found");
}

const PROVIDER = "google" satisfies CredentialProvider;

export const googleIntegrationRoutes = new Elysia({
  prefix: integrationRoutePrefix(PROVIDER),
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  // No `requireOnboarded`: onboarding links to `/connect`.
  .guard({ auth: true }, (app) =>
    app.get(
      "/connect",
      async ({ user, query, set }) => {
        // No `?features` means the full grant (ADR-0044). `?features=` narrows a reconnect.
        let features: readonly GoogleFeature[] | undefined;

        if (query.features) {
          const parsed = query.features
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          const known = parsed.filter((f): f is GoogleFeature => f in GOOGLE_FEATURE_SCOPES);

          if (known.length !== parsed.length) {
            throw Errors.BadRequestError(
              // SAFETY: the cast only types the `.includes` argument; `f` prints unchanged.
              `Unknown feature(s): ${parsed.filter((f) => !known.includes(f as GoogleFeature)).join(", ")}`,
            );
          }

          // `?features=,` means identity scopes only, never the full grant.
          features = known;
        }

        const hasWorkflowId = query.workflowId !== undefined;
        const hasRevisionId = query.revisionId !== undefined;

        if (hasWorkflowId !== hasRevisionId) {
          throw Errors.BadRequestError(
            "workflowId and revisionId must be provided together for workflow recovery",
          );
        }

        const workflowRecovery =
          query.workflowId && query.revisionId
            ? { workflowId: query.workflowId, revisionId: query.revisionId }
            : undefined;

        const nonce = randomBytes(16).toString("hex");
        await rememberOAuthNonce({ provider: PROVIDER, nonce, userId: user.id });

        const state = signOAuthState({
          userId: user.id,
          nonce,
          ...(workflowRecovery ? { workflowRecovery } : {}),
        });

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
          workflowId: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
          revisionId: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        }),
      },
    ),
  )
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .delete(
        "/:id",
        async ({ params, user }) => {
          try {
            await disconnectGoogleCredentialConnection({
              userId: user.id,
              credentialId: params.id,
            });
          } catch (error) {
            if (error instanceof GoogleCredentialNotFoundError) {
              throw Errors.NotFoundError("Credential not found");
            }

            throw error;
          }

          return { id: params.id, ok: true };
        },
        { params: t.Object({ id: t.String() }) },
      )
      .patch(
        "/:id/persona",
        async ({ params, body, user }) => {
          // Persona override (ADR-0051 #3). The `userId` filter is the ownership check.
          const updated = await db()
            .update(integrationCredentials)
            .set({ persona: body.persona })
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
                eq(integrationCredentials.provider, PROVIDER),
              ),
            )
            .returning({ id: integrationCredentials.id, persona: integrationCredentials.persona });

          if (!updated[0]) throw Errors.NotFoundError("Credential not found");

          return { credentialId: updated[0].id, persona: updated[0].persona };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ persona: t.Union(ACCOUNT_PERSONAS.map((p) => t.Literal(p))) }),
        },
      )
      .post(
        "/:id/watch",
        async ({ params, user }) => {
          await assertCredentialOwned(params.id, user.id);
          const topic = serverEnv().GOOGLE_PUBSUB_TOPIC;

          if (!topic) throw Errors.ServiceUnavailableError("GOOGLE_PUBSUB_TOPIC not configured");

          try {
            assertGmailPushOidcConfigured();
          } catch (err) {
            if (isGmailPushOidcConfigError(err)) {
              throw Errors.ServiceUnavailableError(toMessage(err));
            }

            throw err;
          }

          const state = await installGmailWatchAndSeedCursor({
            credentialId: params.id,
            topicName: topic,
          });

          if (!state) {
            // A null watch would read as "installed", so fail loudly.
            throw Errors.ServiceUnavailableError(
              "Gmail mailbox writes are disabled in this environment (GMAIL_MAILBOX_WRITES_ENABLED)",
            );
          }

          return { credentialId: params.id, watch: state };
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      .delete(
        "/:id/watch",
        async ({ params, user }) => {
          await assertCredentialOwned(params.id, user.id);
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
          await assertCredentialOwned(params.id, user.id);
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
          await assertCredentialOwned(params.id, user.id);

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
  // No session here; the signed `state` proves who started the flow.
  .get(
    "/callback",
    async ({ query, set }) => {
      if (!query.code || !query.state) {
        throw Errors.BadRequestError("Missing code or state");
      }

      const decoded = verifyOAuthState(query.state);

      if (!decoded) throw Errors.BadRequestError("Invalid state");

      // Consuming the nonce makes a captured `state` single-use.
      const storedUserId = await consumeOAuthNonce(PROVIDER, decoded.nonce);

      if (!storedUserId || storedUserId !== decoded.userId) {
        throw Errors.BadRequestError("Invalid or expired state");
      }

      const tokens = await exchangeCode(query.code);

      const { credentialId } = await upsertGoogleCredentialConnection({
        userId: decoded.userId,
        accountId: tokens.accountId,
        accountEmail: tokens.accountEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token!,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        tokenType: tokens.token_type,
        hostedDomain: tokens.hostedDomain ?? null,
      });

      // Triage a few recent messages so a new account has sorted mail at once. Idempotent.
      await bestEffort(`failed to enqueue initial-sync for ${credentialId}`, async () => {
        await getIngestionQueue().add("gmail.ingest_recent", {
          kind: "gmail.ingest_recent",
          credentialId,
          maxMessages: 8,
          triageInsertedDocs: true,
        });
      });

      // Without a watch, mail waits for the 5-minute poll sweep (ADR-0037).
      await bestEffort(`failed to enqueue watch install for ${credentialId}`, async () => {
        await getIngestionQueue().add("gmail.watch_install", {
          kind: "gmail.watch_install",
          credentialId,
        });
      });

      await publishGoogleCallbackCompleted(decoded.userId, credentialId);

      // A user still onboarding goes back to step 2.
      const userRow = await db()
        .select({ onboardedAt: user.onboardedAt })
        .from(user)
        .where(eq(user.id, decoded.userId))
        .limit(1);

      const stillOnboarding = userRow[0]?.onboardedAt === null;
      const connectedParam = `google_connected=${encodeURIComponent(tokens.accountEmail)}`;
      let target = stillOnboarding ? `/onboarding?step=2&${connectedParam}` : `/?${connectedParam}`;

      if (!stillOnboarding && decoded.workflowRecovery) {
        target = await resolveWorkflowRecoveryTarget({
          userId: decoded.userId,
          workflowId: decoded.workflowRecovery.workflowId,
          revisionId: decoded.workflowRecovery.revisionId,
        });
      }

      set.status = 302;
      set.headers["Location"] = `${serverEnv().CORS_ORIGIN}${target}`;

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

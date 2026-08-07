import { ACCOUNT_PERSONAS, Errors, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildAuthorizeUrl,
  exchangeCode,
  getGmailWatchState,
  GOOGLE_FEATURE_SCOPES,
  type GoogleFeature,
  scopesForFeatures,
  uninstallGmailWatch,
} from "@alfred/integrations/google";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { authMacro } from "../../middleware/auth";
import { publishDomainEvent } from "../triggers";
import {
  assertGmailPushOidcConfigured,
  getIngestionQueue,
  installGmailWatchAndSeedCursor,
  isGmailPushOidcConfigError,
  resolveWorkflowRecoveryTarget,
} from "../integrations";
import {
  disconnectGoogleCredentialConnection,
  GoogleCredentialNotFoundError,
  upsertGoogleCredentialConnection,
} from "./google-credential-lifecycle";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";

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

/**
 * Best-effort post-callback side effects (initial-sync, watch install, event
 * publication). A
 * failure here must not bounce the user to an OAuth error page, so each is
 * swallowed with a warn.
 */
async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[google.callback] ${label}:`, toMessage(err));
  }
}

type DomainEventPublisher = typeof publishDomainEvent;

/** Publish the completed connection occurrence without naming its consumers. */
export async function publishGoogleCallbackCompleted(
  userId: string,
  credentialId: string,
  publish: DomainEventPublisher = publishDomainEvent,
): Promise<void> {
  await bestEffort(`failed to publish completed event for ${userId}`, () =>
    publish({
      userId,
      source: "google.oauth.callback",
      type: "completed",
      eventId: `google.callback:${credentialId}`,
    }),
  );
}

/**
 * Confirm a credential id belongs to the caller before acting on it —
 * otherwise an authenticated user could drive watch/ingest operations against
 * someone else's credential id. Throws NotFoundError (not Forbidden) so the
 * response never confirms whether the id exists for another user.
 */
async function assertCredentialOwned(id: string, userId: string): Promise<void> {
  const owner = await db()
    .select({ id: integrationCredentials.id })
    .from(integrationCredentials)
    .where(and(eq(integrationCredentials.id, id), eq(integrationCredentials.userId, userId)));
  if (!owner[0]) throw Errors.NotFoundError("Credential not found");
}

export const googleIntegrationRoutes = new Elysia({
  prefix: "/api/integrations/google",
  normalize: "typebox",
})
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .get(
        "/connect",
        async ({ user, query, set }) => {
          // Default (no `?features` param) requests the FULL grant — every
          // feature's scopes in a single consent. Alfred operates as one
          // Production-unverified tenant (ADR-0044, amended 2026-06-08), so
          // there is no scope tier to dodge and no user cap that matters; the
          // owner clicks through the unverified-app warning once and grants
          // the lot. `?features=briefing,triage` narrows the request for a
          // targeted reconnect; `include_granted_scopes=true` (on the
          // authorize URL) merges it into the existing grant rather than
          // re-prompting from scratch.
          let features: readonly GoogleFeature[] | undefined;
          if (query.features) {
            const parsed = query.features
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const known = parsed.filter((f): f is GoogleFeature => f in GOOGLE_FEATURE_SCOPES);
            if (known.length !== parsed.length) {
              throw Errors.BadRequestError(
                `Unknown feature(s): ${parsed.filter((f) => !known.includes(f as GoogleFeature)).join(", ")}`,
              );
            }
            // An explicit param that parses to nothing (e.g. `?features=,`)
            // requests identity scopes only — it must not silently widen to
            // the full grant. `scopesForFeatures([])` returns identity-only.
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
          await rememberOAuthNonce({ provider: "google", nonce, userId: user.id });
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
      )
      .get("/credentials", async ({ user }) => {
        const rows = await db()
          .select({
            id: integrationCredentials.id,
            accountId: integrationCredentials.accountId,
            accountLabel: integrationCredentials.accountLabel,
            status: integrationCredentials.status,
            scopes: integrationCredentials.scopes,
            persona: integrationCredentials.persona,
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
      })
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
          // User override for the auto-detected account persona (ADR-0051 #3).
          // Scoped to the caller's own credential — the WHERE on user.id is the
          // ownership check (no row updated for someone else's id).
          const updated = await db()
            .update(integrationCredentials)
            .set({ persona: body.persona })
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
                eq(integrationCredentials.provider, "google"),
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
            // #278: non-prod mailbox-write gate is off — be explicit rather than
            // returning a null watch the client would read as "installed".
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
          // Confirm the credential belongs to the caller before enqueueing.
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
  // Callback runs unauthenticated — the user is mid-OAuth-flow with Google,
  // not in our session yet (or in a different tab). The signed `state`
  // proves who initiated the flow without needing a session cookie.
  .get(
    "/callback",
    async ({ query, set }) => {
      if (!query.code || !query.state) {
        throw Errors.BadRequestError("Missing code or state");
      }
      const decoded = verifyOAuthState(query.state);
      if (!decoded) throw Errors.BadRequestError("Invalid state");

      // Atomically consume the nonce. If it's missing/expired/already used,
      // reject — this is what makes captured `state` values single-use.
      // We additionally require the persisted userId to match the one in
      // the signed state as a sanity check.
      const storedUserId = await consumeOAuthNonce("google", decoded.nonce);
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

      // Initial-sync seed: pull the last few messages and triage them so a
      // brand-new account has classified mail to look at immediately. The
      // job is idempotent — a re-connect with no new messages fans no
      // triage runs. Capped tight (8 msgs) so first-run LLM cost stays in
      // pennies; bulk historical re-ingest still skips triage.
      await bestEffort(`failed to enqueue initial-sync for ${credentialId}`, () =>
        getIngestionQueue().add("gmail.ingest_recent", {
          kind: "gmail.ingest_recent",
          credentialId,
          maxMessages: 8,
          triageInsertedDocs: true,
        }),
      );

      // Install the Gmail watch so realtime ingestion (ADR-0037: pub/sub →
      // poll_recent → triage) starts immediately. Without this a new account
      // has no watch, so mail is only picked up by the 5-min poll_sweep
      // fallback — the source of the multi-minute tag latency. Enqueued (not
      // inline) to keep the OAuth redirect snappy; best-effort, and the
      // watch-renew cron keeps it alive thereafter.
      await bestEffort(`failed to enqueue watch install for ${credentialId}`, () =>
        getIngestionQueue().add("gmail.watch_install", {
          kind: "gmail.watch_install",
          credentialId,
        }),
      );

      // Publish the connection occurrence through the generic trigger path.
      // Cold-start research is one consumer today; future consumers do not
      // require another integration-owned callback seam.
      await publishGoogleCallbackCompleted(decoded.userId, credentialId);

      // Bounce back to the SPA. If the user hasn't finished onboarding yet,
      // pop them back onto step 2 of the flow (popular-integrations grid)
      // instead of the chat home so the funnel stays linear.
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

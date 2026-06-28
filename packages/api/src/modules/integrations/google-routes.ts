import { ACCOUNT_PERSONAS, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { integrationCredentials, user } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  buildAuthorizeUrl,
  detectPersona,
  exchangeCode,
  getGmailWatchState,
  GOOGLE_FEATURE_SCOPES,
  type GoogleFeature,
  installGmailWatch,
  scopesForFeatures,
  uninstallGmailWatch,
  upsertCredential,
} from "@alfred/integrations/google";
import { deleteIntegrationCredential } from "@alfred/integrations/shared";
import { randomBytes } from "node:crypto";
import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { authMacro } from "../../middleware/auth";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../../middleware/errors";
import { createRun, enqueueRun } from "../agent";
import { isUniqueViolation } from "../agent/service";
import { COLD_START_WORKFLOW_SLUG } from "../cold-start";
import { getIngestionQueue } from "./queue";
import {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";
import {
  assertGmailPushOidcConfigured,
  isGmailPushOidcConfigError,
} from "./gmail-push-config";

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
 * Best-effort post-callback side effects (initial-sync, watch install). A
 * failure here must not bounce the user to an OAuth error page, so each is
 * swallowed with a warn. The cold-start trigger below keeps its own block —
 * it has distinct unique-violation handling.
 */
async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[google.callback] ${label}:`, toMessage(err));
  }
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
              throw new BadRequestError(
                `Unknown feature(s): ${parsed.filter((f) => !known.includes(f as GoogleFeature)).join(", ")}`,
              );
            }
            // An explicit param that parses to nothing (e.g. `?features=,`)
            // requests identity scopes only — it must not silently widen to
            // the full grant. `scopesForFeatures([])` returns identity-only.
            features = known;
          }

          const nonce = randomBytes(16).toString("hex");
          await rememberOAuthNonce({ provider: "google", nonce, userId: user.id });
          const state = signOAuthState({ userId: user.id, nonce });
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
          // Ownership check first, mirroring the sibling `/:id/watch` routes —
          // the watch teardown below operates on a raw credential id, so we
          // must confirm the caller owns it before touching anything.
          const owner = await db()
            .select({ id: integrationCredentials.id })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
                eq(integrationCredentials.provider, "google"),
              ),
            );
          if (!owner[0]) throw new NotFoundError("Credential not found");
          // Stop Google pushing to our Pub/Sub topic before the row (and its
          // access token) disappear. Best-effort: a watch that was never
          // installed or already expired must not block the disconnect. One
          // Google credential backs every google_* tile, so this removes
          // Alfred's whole Workspace grant for the account.
          await bestEffort("uninstall watch on disconnect", () => uninstallGmailWatch(params.id));
          await deleteIntegrationCredential({ userId: user.id, provider: "google", id: params.id });
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
          if (!updated[0]) throw new NotFoundError("Credential not found");
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
          const owner = await db()
            .select({ id: integrationCredentials.id })
            .from(integrationCredentials)
            .where(
              and(
                eq(integrationCredentials.id, params.id),
                eq(integrationCredentials.userId, user.id),
              ),
            );
          if (!owner[0]) throw new NotFoundError("Credential not found");
          const topic = serverEnv().GOOGLE_PUBSUB_TOPIC;
          if (!topic) throw new ServiceUnavailableError("GOOGLE_PUBSUB_TOPIC not configured");
          try {
            assertGmailPushOidcConfigured();
          } catch (err) {
            if (isGmailPushOidcConfigError(err)) {
              throw new ServiceUnavailableError(toMessage(err));
            }
            throw err;
          }
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
          if (!owner[0]) throw new NotFoundError("Credential not found");
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
          if (!owner[0]) throw new NotFoundError("Credential not found");
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
          if (!owner[0]) throw new NotFoundError("Credential not found");

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
        throw new BadRequestError("Missing code or state");
      }
      const decoded = verifyOAuthState(query.state);
      if (!decoded) throw new BadRequestError("Invalid state");

      // Atomically consume the nonce. If it's missing/expired/already used,
      // reject — this is what makes captured `state` values single-use.
      // We additionally require the persisted userId to match the one in
      // the signed state as a sanity check.
      const storedUserId = await consumeOAuthNonce("google", decoded.nonce);
      if (!storedUserId || storedUserId !== decoded.userId) {
        throw new BadRequestError("Invalid or expired state");
      }

      const tokens = await exchangeCode(query.code);
      const credential = await upsertCredential({
        userId: decoded.userId,
        provider: "google",
        accountId: tokens.accountId,
        accountLabel: tokens.accountEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token!,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        // Persona auto-detect (ADR-0051 #3): Workspace `hd` claim → work,
        // absent → personal. `upsertCredential` only fills it when NULL, so a
        // user override survives this re-connect. Raw `hd` kept for audit.
        persona: detectPersona(tokens.hostedDomain),
        metadata: {
          token_type: tokens.token_type,
          ...(tokens.hostedDomain ? { googleHostedDomain: tokens.hostedDomain } : {}),
        },
      });

      // Initial-sync seed: pull the last few messages and triage them so a
      // brand-new account has classified mail to look at immediately. The
      // job is idempotent — a re-connect with no new messages fans no
      // triage runs. Capped tight (8 msgs) so first-run LLM cost stays in
      // pennies; bulk historical re-ingest still skips triage.
      await bestEffort(`failed to enqueue initial-sync for ${credential.id}`, () =>
        getIngestionQueue().add("gmail.ingest_recent", {
          kind: "gmail.ingest_recent",
          credentialId: credential.id,
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
      await bestEffort(`failed to enqueue watch install for ${credential.id}`, () =>
        getIngestionQueue().add("gmail.watch_install", {
          kind: "gmail.watch_install",
          credentialId: credential.id,
        }),
      );

      // Cold-start research seed (ADR-0011 + ADR-0022): once at most per
      // user. Google is currently the only integration that contributes
      // signals beyond the bare user row, so this callback doubles as the
      // "onboarding complete enough to research" trigger.
      //
      // Lifetime uniqueness is enforced at the DB level: the workflow
      // declares `dedupKey: () => 'cold-start'`, and the partial unique
      // index on `agent_runs.(user_id, workflow_slug, dedup_key)` makes
      // a duplicate `createRun` fail with Postgres `23505`. Two
      // simultaneous callbacks both insert; the loser gets a unique
      // violation and falls through. A prior failed/cancelled run is
      // excluded from the index, so a transient Perplexity outage isn't
      // a permanent lockout — a later reconnect re-fires.
      //
      // Try/catch eats both unique-violations (expected on reconnect)
      // and any other failure — a research-trigger problem must not
      // bounce the user back to an OAuth error page.
      try {
        const { runId } = await createRun({
          userId: decoded.userId,
          workflowSlug: COLD_START_WORKFLOW_SLUG,
          input: { reason: "signup" },
          // OAuth callback is an external system event (Google's IdP).
          // `eventId` is the credential id — naturally per-occurrence,
          // and the `dedupKey: () => 'cold-start'` on the workflow
          // already enforces lifetime-once, so this is mostly for
          // breadcrumb-style filtering in History.
          trigger: {
            kind: "event",
            source: "google.oauth.callback",
            type: "completed",
            eventId: `google.callback:${credential.id}`,
          },
        });
        await enqueueRun(runId);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Reconnect after a successful (or in-flight) prior run —
          // expected, log at info level only.
          console.log(
            `[google.callback] cold-start research already exists for ${decoded.userId}; skipping.`,
          );
        } else {
          console.warn(
            `[google.callback] failed to enqueue cold-start research for ${decoded.userId}:`,
            toMessage(err),
          );
        }
      }

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
      const target = stillOnboarding
        ? `/onboarding?step=2&${connectedParam}`
        : `/?${connectedParam}`;
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

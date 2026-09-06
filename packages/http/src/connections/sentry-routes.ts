import {
  Errors,
  integrationRoutePrefix,
  redactSecrets,
  toMessage,
  type CredentialProvider,
} from "@alfred/contracts";
import {
  isSentryAuthorizationError,
  isSentryConfigured,
  SentryInstallationNotFoundError,
  sentryValidateToken,
} from "@alfred/integrations/sentry";
import { deleteIntegrationCredential, upsertBearerCredential } from "@alfred/integrations/shared";
import { Elysia, t } from "elysia";
import { ZodError } from "zod";
import { authMacro } from "../middleware/auth";
import { requireOnboarded } from "../middleware/onboarding";

/**
 * Sentry integration routes. Sentry's public OAuth is for *public* integrations
 * only, so the user pastes an internal-integration token together with the
 * organization slug it belongs to. The connect route validates both against the
 * Sentry API, resolves the integration's installation uuid (the join key every
 * webhook delivery carries), and stores the token via the shared bearer layer
 * with that uuid in `installation_id`. A bad token or a wrong organization is
 * rejected at connect, not at first tool call or first delivery.
 *
 *   POST   /api/integrations/sentry/connect   { token, organization }  → validate + store
 *   DELETE /api/integrations/sentry/:id                                → disconnect
 *
 * Connection state is read from `GET /api/integrations` (`../integrations.ts`).
 */
const PROVIDER = "sentry" satisfies CredentialProvider;

export const sentryIntegrationRoutes = new Elysia({
  prefix: integrationRoutePrefix(PROVIDER),
  normalize: "typebox",
})
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .post(
        "/connect",
        async ({ user, body }) => {
          if (!isSentryConfigured()) {
            throw Errors.ServiceUnavailableError("Sentry integration is not configured");
          }
          const token = body.token.trim();
          const organization = body.organization.trim();
          if (!token) throw Errors.BadRequestError("Missing token");
          if (!organization) throw Errors.BadRequestError("Missing organization slug");
          let connection: Awaited<ReturnType<typeof sentryValidateToken>>;
          try {
            connection = await sentryValidateToken({ token, organization });
          } catch (err) {
            // Log the real upstream reason (redacted + bounded) so prod failures
            // are diagnosable, but never leak it to the client.
            console.error(
              `[sentry.connect] token validation failed :: ${redactSecrets(toMessage(err))}`,
            );
            if (err instanceof SentryInstallationNotFoundError) {
              throw Errors.BadRequestError(
                "That organization does not have Alfred's Sentry integration installed.",
              );
            }
            // Only an authorization failure means the pasted token is wrong. A
            // transient upstream failure must not tell the user to regenerate a
            // token that is perfectly valid.
            if (isSentryAuthorizationError(err)) {
              throw Errors.BadRequestError(
                "Sentry rejected that token for that organization. Check both and try again.",
              );
            }
            // Sentry answered, but not in the shape the validator parses. That is
            // a contract drift on our side, not an outage: name it so it is not
            // retried as one.
            if (err instanceof ZodError) {
              throw Errors.BadGatewayError(
                "Sentry answered in a shape Alfred does not understand. This is a bug on Alfred's side.",
              );
            }
            throw Errors.ServiceUnavailableError(
              "Sentry is unavailable right now. Try connecting again in a moment.",
            );
          }
          const label = connection.organization.slug;
          const credential = await upsertBearerCredential({
            userId: user.id,
            provider: PROVIDER,
            accountId: connection.organization.id,
            accountLabel: label,
            accessToken: token,
            installationId: connection.installationUuid,
          });
          return { id: credential.id, accountLabel: label };
        },
        {
          body: t.Object({
            token: t.String({ minLength: 1, maxLength: 4000 }),
            organization: t.String({ minLength: 1, maxLength: 200 }),
          }),
        },
      )
      .delete(
        "/:id",
        async ({ params, user }) => {
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
  );

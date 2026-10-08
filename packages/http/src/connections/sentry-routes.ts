import {
  Errors,
  integrationRoutePrefix,
  redactSecrets,
  toMessage,
  type CredentialProvider,
} from "@alfred/contracts";
import { isSentryAuthorizationError, sentryValidateToken } from "@alfred/integrations/sentry";
import {
  deleteIntegrationCredential,
  findSoleActiveCredential,
  upsertBearerCredential,
} from "@alfred/integrations/shared";
import { Elysia, t } from "elysia";
import { ZodError } from "zod";
import { authMacro } from "../middleware/auth";
import { requireOnboarded } from "../middleware/onboarding";

/**
 * Sentry connect with a pasted internal-integration token and org slug; Sentry OAuth
 * is for public integrations only. Both are checked at connect. No installation id:
 * webhooks are attributed by signature.
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
          const token = body.token.trim();
          const organization = body.organization.trim();

          if (!token) throw Errors.BadRequestError("Missing token");

          if (!organization) throw Errors.BadRequestError("Missing organization slug");
          let connection: Awaited<ReturnType<typeof sentryValidateToken>>;

          try {
            connection = await sentryValidateToken({ token, organization });
          } catch (err) {
            // Log the upstream reason; never send it to the client.
            console.error(
              `[sentry.connect] token validation failed :: ${redactSecrets(toMessage(err))}`,
            );

            // Only an auth failure means a bad token. An outage must not say "regenerate".
            if (isSentryAuthorizationError(err)) {
              throw Errors.BadRequestError(
                "Sentry rejected that token for that organization. Check both and try again.",
              );
            }

            // An unexpected shape is contract drift, not an outage.
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
          // One Client Secret maps to one credential; a second org would silence webhooks for both.
          const existing = await findSoleActiveCredential({ provider: PROVIDER });

          const sameRow =
            existing.kind === "one" &&
            existing.credential.userId === user.id &&
            existing.credential.accountId === connection.organization.id;

          if (existing.kind === "many" || (existing.kind === "one" && !sameRow)) {
            throw Errors.ConflictError(
              "Alfred pairs with one Sentry organization. Disconnect the connected one first.",
            );
          }

          const credential = await upsertBearerCredential({
            userId: user.id,
            provider: PROVIDER,
            accountId: connection.organization.id,
            accountLabel: label,
            accessToken: token,
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

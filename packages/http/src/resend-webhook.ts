import { Elysia, type Context } from "elysia";
import { receiveResendWebhook, type ResendWebhookOutcome } from "@alfred/assistant/delivery";
import { assertNever } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { rawBodyRoute } from "./connections/inbound-webhook";

/**
 * Resend Receiving webhook: `POST /webhooks/resend`, event `email.received`.
 * It forwards each mail for the Alfred domain to the owner's account email.
 * A missing Svix header or a bad signature is 400. A failed forward is 500, so Resend retries.
 */

function respond(outcome: ResendWebhookOutcome, set: Context["set"]) {
  switch (outcome.kind) {
    case "not_configured":
      set.status = 503;

      return { ok: false as const, error: "resend webhook not configured" };
    case "rejected":
      set.status = 400;

      return { ok: false as const, error: outcome.reason };
    case "ignored":
      return { ok: true as const, ignored: outcome.reason };
    case "duplicate":
      return { ok: true as const, duplicate: true as const, emailSendId: outcome.emailSendId };
    case "forwarded":
      return { ok: true as const, emailSendId: outcome.emailSendId };
    case "failed":
      logger.error(`[resend-webhook] forward failed: ${outcome.error}`);
      set.status = 500;

      return { ok: false as const, error: "forward failed" };
    default:
      return assertNever(outcome, "resend webhook outcome kind");
  }
}

export const resendWebhookRoutes = new Elysia({ prefix: "/webhooks", normalize: "typebox" }).post(
  "/resend",
  async ({ body, request, set }) =>
    respond(await receiveResendWebhook({ raw: body, headers: request.headers }), set),
  rawBodyRoute,
);

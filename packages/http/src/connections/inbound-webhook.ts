import { Elysia, t, type Context } from "elysia";
import {
  receiveInboundDelivery,
  type InboundDeliveryOutcome,
} from "@alfred/assistant/connections/ingestion";

/**
 * Generic webhook receiver (ADR-0097): unknown source 404, bad signature 401,
 * anything else 200 so the provider never retries.
 * `POST /webhooks/github` is a legacy alias; the GitHub App still points there.
 * Gmail uses `gmail-webhook.ts` (OIDC, and it carries a pointer, not the event).
 */

const rawBodyRoute = {
  // Raw text, so the HMAC covers the provider's exact bytes.
  parse: ({ request }: { request: Request }) => request.text(),
  body: t.String(),
} as const;

function respond(outcome: InboundDeliveryOutcome, set: Context["set"]) {
  switch (outcome.kind) {
    case "unknown_source":
      set.status = 404;

      return { ok: false as const, error: "unknown source" };
    case "rejected":
      set.status = 401;

      return { ok: false as const, error: "invalid signature" };
    case "ignored":
      return { ok: true as const, ignored: outcome.reason };
    case "duplicate":
      return { ok: true as const, duplicate: true as const, receiptId: outcome.receiptId };
    case "accepted":
      return { ok: true as const, receiptId: outcome.receiptId };
    case "raw":
      return { ok: true as const, receiptId: outcome.receiptId, raw: true as const };
    default: {
      const _exhaustive: never = outcome;

      return _exhaustive;
    }
  }
}

export const inboundWebhookRoutes = new Elysia({ prefix: "/webhooks", normalize: "typebox" })
  .post(
    "/inbound/:source",
    async ({ params, body, request, set }) =>
      respond(
        await receiveInboundDelivery({
          source: params.source,
          raw: body,
          headers: request.headers,
        }),
        set,
      ),
    { ...rawBodyRoute, params: t.Object({ source: t.String() }) },
  )
  .post(
    "/github",
    async ({ body, request, set }) =>
      respond(
        await receiveInboundDelivery({
          source: "github",
          raw: body,
          headers: request.headers,
        }),
        set,
      ),
    rawBodyRoute,
  );

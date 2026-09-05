import { Elysia, t } from "elysia";
import {
  receiveInboundDelivery,
  type InboundDeliveryOutcome,
} from "@alfred/assistant/connections/ingress";
import { enqueueInboundDelivery } from "@alfred/assistant/connections/ingestion";

/**
 * The one inbound webhook door (ADR-0097).
 *
 *   provider ──webhook──> POST /webhooks/inbound/:source
 *
 * The route knows nothing about any provider. It hands the exact request bytes
 * and headers to `receiveInboundDelivery`, which looks the `:source` segment up
 * in the descriptor registry, verifies the RAW body before any parse, stores one
 * `event_receipts` row and enqueues its delivery. The status map is the whole
 * transport contract: an unknown source is 404, a bad signature is 401 (the
 * provider shows it in its delivery log and does not spin retries), and every
 * other outcome is 200 so a provider never retries a body we already stored or
 * deliberately dropped.
 *
 * `POST /webhooks/github` is the legacy alias: the GitHub App's hook URL on
 * Railway points there. It runs the same path with `source` fixed to `github`.
 *
 * Gmail is not here. Its Pub/Sub push is OIDC-authenticated and carries a
 * pointer, not the event, so `gmail-webhook.ts` keeps its own route.
 */

const rawBodyRoute = {
  // Hand the handler the raw body string so the descriptor's HMAC is over the
  // provider's exact bytes, not a re-serialized parse.
  parse: ({ request }: { request: Request }) => request.text(),
  body: t.String(),
} as const;

function respond(outcome: InboundDeliveryOutcome, set: { status?: number | string }) {
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
          enqueue: enqueueInboundDelivery,
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
          enqueue: enqueueInboundDelivery,
        }),
        set,
      ),
    rawBodyRoute,
  );

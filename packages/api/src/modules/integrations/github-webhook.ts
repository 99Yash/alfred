import { db } from "@alfred/db";
import { webhookEvents } from "@alfred/db/schemas";
import { findUserByInstallationId, verifyWebhookSignature } from "@alfred/integrations/github";
import { Elysia, t } from "elysia";
import { objectStateStore } from "./object-state";

/**
 * GitHub App activity receiver (ADR-0052).
 *
 *   GitHub App ──webhook──> POST /webhooks/github
 *
 * Two gates before anything is stored:
 *   1. `X-Hub-Signature-256` HMAC over the *raw* body (a route-level `parse`
 *      hook hands us the exact bytes — re-serializing the parsed JSON would
 *      change whitespace and break the comparison).
 *   2. The delivery is for a subscribed event we know how to file.
 *
 * Idempotency is the whole design: GitHub redelivers on any non-2xx and on
 * manual replay, so we insert `on conflict do nothing` keyed by the
 * `X-GitHub-Delivery` UUID. A duplicate is a silent no-op rather than a
 * double-counted activity item. We return 200 fast; the briefing reads
 * `webhook_events` directly, so there's no async fan-out to wait on.
 *
 * Webhooks are delivered to the deployed server only (the App's hook URL is
 * the Railway domain) — localhost can't receive them.
 */

// Mirrors the App's subscribed `default_events`.
const SUBSCRIBED_EVENTS = new Set(["pull_request", "push", "issues", "pull_request_review"]);

interface GithubWebhookBody {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
}

export const githubWebhookRoutes = new Elysia({ prefix: "/webhooks", normalize: "typebox" }).post(
  "/github",
  async ({ body, headers, set }) => {
    const raw = typeof body === "string" ? body : "";
    if (!verifyWebhookSignature(raw, headers["x-hub-signature-256"] ?? null)) {
      // Bad signature → 401. GitHub surfaces this in the App's "Recent
      // Deliveries" tab; it won't spin retries forever the way Pub/Sub does.
      set.status = 401;
      return { ok: false, error: "invalid signature" };
    }

    const eventType = headers["x-github-event"] ?? "unknown";
    const deliveryId = headers["x-github-delivery"] ?? null;

    // GitHub pings once on subscription; ack it so the App shows green.
    if (eventType === "ping") return { ok: true, pong: true };
    if (!SUBSCRIBED_EVENTS.has(eventType)) return { ok: true, ignored: eventType };
    if (!deliveryId) return { ok: true, ignored: "no-delivery-id" };

    let payload: GithubWebhookBody;
    try {
      payload = JSON.parse(raw) as GithubWebhookBody;
    } catch {
      return { ok: true, ignored: "bad-json" };
    }

    const installationId =
      payload.installation?.id != null ? String(payload.installation.id) : null;
    const userId = installationId ? await findUserByInstallationId(installationId) : null;
    const deliveredAt = new Date();

    await db()
      .insert(webhookEvents)
      .values({
        provider: "github",
        providerEventId: deliveryId,
        eventType,
        action: payload.action ?? null,
        repo: payload.repository?.full_name ?? null,
        installationId,
        userId,
        payload: payload as Record<string, unknown>,
        deliveredAt,
      })
      .onConflictDoNothing({
        target: [webhookEvents.provider, webhookEvents.providerEventId],
      });

    // Fold the delivery into object-state (ADR-0062) for loop-closure. The
    // reducer is idempotent + monotonic, so re-running it on a redelivered
    // (and thus conflict-skipped) event is safe — no need to gate on the
    // insert returning. A reducer failure must never 500 the webhook (GitHub
    // would spin retries), so it's isolated; the event log is already durable.
    if (userId) {
      try {
        await objectStateStore.applyEvent({
          userId,
          provider: "github",
          eventType,
          action: payload.action ?? null,
          payload,
          deliveredAt,
        });
      } catch (err) {
        console.error("[github-webhook] object-state applyEvent failed", err);
      }
    }

    return { ok: true };
  },
  {
    // Hand the handler the raw body string so the HMAC is over GitHub's exact
    // bytes, not a re-serialized parse.
    parse: ({ request }) => request.text(),
    body: t.String(),
  },
);

import { getStringPath, isEventTypeForSource, type JsonObject } from "@alfred/contracts";
import {
  findActiveCredentialByInstallationId,
  hasActiveInstallationCredential,
  payloadIdAt,
} from "@alfred/integrations/shared";
import {
  SENTRY_HOOK_HEADERS,
  sentryInstallationUuid,
  verifySentryWebhookSignature,
} from "@alfred/integrations/sentry";
import type { InboundProjection, InboundSourceDescriptor, InboundSyntheticKey } from "./descriptor";

/**
 * Sentry internal-integration webhooks (ADR-0097, #563). Sentry signs the raw
 * body with the integration's Client Secret (`Sentry-Hook-Signature`), names
 * the resource in `Sentry-Hook-Resource`, and completes it with the body's
 * `action`. The owner is the credential whose `installation_id` matches
 * `installation.uuid` at the payload root, which the connect flow stored.
 *
 * There is no stable delivery id: `Request-ID` is a fresh uuid inside each of
 * Sentry's three retries, so keying on it would admit every retry as a new
 * receipt. The key is synthetic over payload identity, per resource, because
 * the same event sits at a different path per resource (`data.error` for
 * `error`, `data.event` for `event_alert`), and a generic extractor would
 * yield `null` for half the traffic. The resource prefix keeps two resources
 * that share an id (an issue's `created` transition and its alert) apart.
 *
 * Sentry retries only on network failure or timeout, never on a 4xx, and
 * unsubscribes a hook after 1000 timeouts in 24h. The shared receive path
 * answers 200 as soon as the receipt row exists, and every internal rejection
 * is also a 200, so nothing here can make Sentry drop the subscription.
 */

const IGNORED_RESOURCES: ReadonlySet<string> = new Set(["installation", "comment", "metric_alert"]);

/** `<resource>:<identity>`, or `null` when the resource has no identity we key on. */
const sentryDeliveryKey: InboundSyntheticKey = (payload, headers) => {
  const resource = headers.get(SENTRY_HOOK_HEADERS.resource);
  const action = getStringPath(payload, "action");
  switch (resource) {
    case "error": {
      const eventId = payloadIdAt(payload, "data", "error", "event_id");
      return eventId ? `error:${eventId}` : null;
    }
    case "event_alert": {
      // One event can legitimately match two alert rules; the rule label keeps
      // those two alerts distinct without splitting one alert's retries. A
      // delivery without the label still keys on the event: merging two
      // unlabeled alerts loses less than dropping a real one, and a retry
      // carries the same body either way.
      const eventId = payloadIdAt(payload, "data", "event", "event_id");
      if (!eventId) return null;
      const rule = getStringPath(payload, "data", "triggered_rule");
      return rule ? `event_alert:${eventId}:${rule}` : `event_alert:${eventId}`;
    }
    case "issue": {
      const issueId = payloadIdAt(payload, "data", "issue", "id");
      return issueId && action ? `issue:${issueId}:${action}` : null;
    }
    case "seer": {
      const runId = payloadIdAt(payload, "data", "run_id");
      return runId && action ? `seer:${runId}:${action}` : null;
    }
    default:
      return null;
  }
};

function projectSentry(payload: JsonObject, headers: Headers): InboundProjection<"sentry"> {
  const resource = headers.get(SENTRY_HOOK_HEADERS.resource);
  if (!resource) return { kind: "ignore", reason: "no-resource-header" };
  // Sentry sends `installation.created`/`deleted` when the integration is
  // (un)installed; the connect flow, not a delivery, is what records that.
  if (IGNORED_RESOURCES.has(resource)) return { kind: "ignore", reason: resource };
  const action = getStringPath(payload, "action");
  if (!action) return { kind: "ignore", reason: `no-action:${resource}` };
  const type = `${resource}_${action}`;
  return isEventTypeForSource("sentry", type)
    ? { kind: "event", type }
    : { kind: "ignore", reason: `unsubscribed:${resource}.${action}` };
}

export const sentryInboundSource: InboundSourceDescriptor<"sentry"> = {
  slug: "sentry",
  verify: (raw, headers) =>
    verifySentryWebhookSignature(raw, headers.get(SENTRY_HOOK_HEADERS.signature)),
  dedup: { kind: "synthetic", key: sentryDeliveryKey },
  project: projectSentry,
  resolveOwner: async (payload) => {
    const uuid = sentryInstallationUuid(payload);
    if (!uuid) return null;
    const credential = await findActiveCredentialByInstallationId("sentry", uuid);
    return credential
      ? { userId: credential.userId, credentialId: credential.id, accountRef: credential.accountId }
      : null;
  },
  subscription: {
    async health(userId) {
      // A credential without an installation uuid cannot own a delivery, so
      // "connected" alone is not "subscribed".
      const installed = await hasActiveInstallationCredential(userId, "sentry");
      return installed
        ? { healthy: true }
        : {
            healthy: false,
            reason: "no Sentry organization with Alfred's integration installed is connected",
            recovery: { kind: "connect", integration: "sentry" },
          };
    },
  },
};

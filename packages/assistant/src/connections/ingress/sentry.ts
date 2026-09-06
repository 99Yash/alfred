import { getIdPath, getStringPath, isEventTypeForSource, type JsonObject } from "@alfred/contracts";
import {
  findActiveCredentialByInstallationId,
  hasActiveInstallationCredential,
} from "@alfred/integrations/shared";
import {
  SENTRY_HOOK_HEADERS,
  sentryInstallationUuid,
  sentryWebhookSecretConfigured,
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
 * receipt. The key is synthetic over payload identity, per event type, because
 * the same event sits at a different path per resource (`data.error` for
 * `error`, `data.event` for `event_alert`), and a generic extractor would
 * yield `null` for half the traffic. The type prefix keeps two resources that
 * share an id (an issue's `created` transition and its alert) apart.
 *
 * Sentry retries only on network failure or timeout, never on a 4xx, and
 * unsubscribes a hook after 1000 timeouts in 24h. The shared receive path
 * answers 200 as soon as the receipt row exists, and every internal rejection
 * is also a 200, so nothing here can make Sentry drop the subscription.
 *
 * Known gap: Sentry sends `installation.deleted` when the user uninstalls the
 * integration, and nothing here consumes it, so the credential stays `active`
 * and health stays green until the next authenticated read fails. The connect
 * flow cannot observe an uninstall. GitHub's `installation` event with action
 * `deleted` has the same gap; the descriptor contract needs a lifecycle slot
 * for both, which is a follow-up, not a Sentry special case.
 */

/**
 * `<type>:<identity>`, or `null` when the payload lacks the identity the type
 * is keyed on. The switch is exhaustive over the entry's event types: adding a
 * type to `EVENT_SOURCE_ENTRIES.sentry` without a case here does not compile.
 */
const sentryDeliveryKey: InboundSyntheticKey<"sentry"> = ({ payload, type, payloadHash }) => {
  switch (type) {
    case "error_created": {
      const eventId = getIdPath(payload, "data", "error", "event_id");
      return eventId ? `${type}:${eventId}` : null;
    }
    case "event_alert_triggered": {
      // One event can legitimately match two alert rules; the rule label keeps
      // those two alerts distinct without splitting one alert's retries. A
      // delivery without the label still keys on the event: merging two
      // unlabeled alerts loses less than dropping a real one, and a retry
      // carries the same body either way.
      const eventId = getIdPath(payload, "data", "event", "event_id");
      if (!eventId) return null;
      const rule = getStringPath(payload, "data", "triggered_rule");
      return rule ? `${type}:${eventId}:${rule}` : `${type}:${eventId}`;
    }
    case "issue_created": {
      const issueId = getIdPath(payload, "data", "issue", "id");
      return issueId ? `${type}:${issueId}` : null;
    }
    case "issue_resolved":
    case "issue_unresolved":
    case "issue_assigned":
    case "issue_archived": {
      // These transitions repeat on one issue: resolved, regressed, resolved
      // again two days later. `(issue, action)` alone would file the second
      // resolve as a duplicate of the first and lose it for good. The
      // lifecycle payload carries no per-transition id and Sentry re-mints
      // both `Request-ID` and the timestamp on retry, so the body digest is
      // the widest fact that a retry of one transition still shares: Sentry
      // re-sends the serialized issue it queued. A second transition arrives
      // with a changed issue (new `lastSeen`, `status`, or `assignedTo`), so
      // its digest differs. Residual: a retry whose issue changed between
      // attempts also gets a fresh digest and a second receipt. Retries are
      // rare (network failure or timeout only), so that duplicate loses less
      // than the dropped transition it replaces.
      const issueId = getIdPath(payload, "data", "issue", "id");
      return issueId ? `${type}:${issueId}:${payloadHash.slice(0, 16)}` : null;
    }
    case "seer_pr_created": {
      const runId = getIdPath(payload, "data", "run_id");
      return runId ? `${type}:${runId}` : null;
    }
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
};

function projectSentry(payload: JsonObject, headers: Headers): InboundProjection<"sentry"> {
  const resource = headers.get(SENTRY_HOOK_HEADERS.resource);
  if (!resource) return { kind: "ignore", reason: "no-resource-header" };
  const action = getStringPath(payload, "action");
  if (!action) return { kind: "ignore", reason: `no-action:${resource}` };
  // The registry is the one list of what is subscribed. `installation`,
  // `comment`, and `metric_alert` deliveries fall out here as unsubscribed;
  // no second list names them.
  const type = `${resource}_${action}`;
  return isEventTypeForSource("sentry", type)
    ? { kind: "event", type }
    : { kind: "ignore", reason: `unsubscribed:${resource}.${action}` };
}

export const sentryInboundSource: InboundSourceDescriptor<"sentry"> = {
  slug: "sentry",
  verify: (raw, headers) => {
    const verdict = verifySentryWebhookSignature(raw, headers.get(SENTRY_HOOK_HEADERS.signature));
    if (verdict === "no_secret") {
      // Named apart from a mismatch so an operator reads "set the env var",
      // not "find the key that disagrees".
      console.error(
        "[ingress] sentry: SENTRY_WEBHOOK_CLIENT_SECRET is not set; delivery rejected unverified",
      );
    }
    return verdict === "verified";
  },
  dedup: { kind: "synthetic", key: sentryDeliveryKey },
  project: projectSentry,
  resolveOwner: async (payload) => {
    const uuid = sentryInstallationUuid(payload);
    if (!uuid) return null;
    const credential = await findActiveCredentialByInstallationId({
      provider: "sentry",
      installationId: uuid,
    });
    return credential
      ? { userId: credential.userId, credentialId: credential.id, accountRef: credential.accountId }
      : null;
  },
  subscription: {
    async health(userId) {
      // Without the Client Secret every delivery is rejected with 401, and
      // Sentry does not retry a 4xx. That is a subscription that cannot
      // deliver, so it reads unhealthy here (ADR-0097 item 5) instead of
      // silently filling Sentry's delivery log with rejections. Only an
      // operator can set the env var, so there is no user-facing recovery.
      if (!sentryWebhookSecretConfigured()) {
        return {
          healthy: false,
          reason: "SENTRY_WEBHOOK_CLIENT_SECRET is not set, so every Sentry delivery is rejected",
          recovery: { kind: "none" },
        };
      }
      // A credential without an installation uuid cannot own a delivery, so
      // "connected" alone is not "subscribed".
      const installed = await hasActiveInstallationCredential({ userId, provider: "sentry" });
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

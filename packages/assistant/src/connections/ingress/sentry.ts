import { getIdPath, getStringPath, isEventTypeForSource, type JsonObject } from "@alfred/contracts";
import { findSoleActiveCredential } from "@alfred/integrations/shared";
import {
  SENTRY_HOOK_HEADERS,
  sentryWebhookSecretConfigured,
  verifySentryWebhookSignature,
} from "@alfred/integrations/sentry";
import type { InboundProjection, InboundSourceDescriptor, InboundSyntheticKey } from "./descriptor";
import { describeInboundJson } from "./description";

/**
 * Sentry internal-integration webhooks (ADR-0097, #563). Sentry signs the raw
 * body with the integration's Client Secret (`Sentry-Hook-Signature`), names
 * the resource in `Sentry-Hook-Resource`, and completes it with the body's
 * `action`. The owner is the one active Sentry credential: the body names no
 * organization, the connect flow cannot learn the installation uuid (an
 * integration token gets 404 from the installations list, see
 * `@alfred/integrations/sentry`), and one Client Secret is one integration in
 * one organization, so a verified signature already identifies the sender. Two
 * active credentials would need two secrets, which one env var cannot hold, so
 * that case is refused, not guessed.
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
 * A `<resource>.<action>` pair the `sentry` entry does not name (`comment.created`,
 * `metric_alert.critical`, `installation.deleted`) is a raw receipt (ADR-0097
 * item 9) under that pair as Sentry spells it; a resource with no `action` is
 * a raw receipt under the bare resource. Only a delivery with no resource
 * header is dropped.
 *
 * Known gap: Sentry sends `installation.deleted` when the user uninstalls the
 * integration, and nothing consumes it beyond the raw receipt, so the
 * credential stays `active` and health stays green until the next
 * authenticated read fails. The connect flow cannot observe an uninstall.
 * GitHub's `installation` event with action `deleted` has the same gap; the
 * descriptor contract needs a lifecycle slot for both, which is a follow-up,
 * not a Sentry special case.
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
  if (!resource) return { kind: "ignore", reason: "no-kind-header" };
  const action = getStringPath(payload, "action");
  // A resource with no `action` is still a real delivery; GitHub keeps the bare
  // event the same way, so the two descriptors agree on what "unnamed" means.
  if (!action) return { kind: "raw", rawKind: resource };
  // The registry is the one list of what is typed. `installation`, `comment`,
  // and `metric_alert` deliveries fall out here as raw under Sentry's own
  // `<resource>.<action>` spelling; no second list names them.
  const type = `${resource}_${action}`;
  return isEventTypeForSource("sentry", type)
    ? { kind: "event", type }
    : { kind: "raw", rawKind: `${resource}.${action}` };
}

export const sentryInboundSource: InboundSourceDescriptor<"sentry"> = {
  slug: "sentry",
  describe: (kind, payload) => describeInboundJson("sentry", kind, payload),
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
  resolveOwner: async () => {
    const sole = await findSoleActiveCredential({ provider: "sentry" });
    if (sole.kind === "many") {
      console.error(
        "[ingress] sentry: more than one active credential shares one SENTRY_WEBHOOK_CLIENT_SECRET; delivery not attributed",
      );
      return null;
    }
    if (sole.kind === "none") return null;
    const { credential } = sole;
    return {
      userId: credential.userId,
      credentialId: credential.id,
      accountRef: credential.accountId,
    };
  },
  subscription: {
    async health(userId) {
      // The credential question comes first, and the deployment question
      // second, because only the first order tells the truth to a user who
      // never connected Sentry (ADR-0100). The env var is unset by default and
      // `.env.example` ships it empty, so a secret-first order answers
      // "SENTRY_WEBHOOK_CLIENT_SECRET is not set" to every user of every
      // deployment that has not registered Sentry — including the ones with
      // nothing to repair. Both orders return the same healthy/unhealthy
      // verdict; they differ only in which reason wins when both are wrong,
      // and the connected question is the one the user can answer.
      //
      // The same rule `resolveOwner` applies, so health cannot read green while
      // every delivery is being dropped.
      const sole = await findSoleActiveCredential({ provider: "sentry" });
      if (sole.kind === "none" || (sole.kind === "one" && sole.credential.userId !== userId)) {
        return {
          healthy: false,
          cause: "never_connected",
          reason: "no Sentry organization is connected",
          recovery: { kind: "connect", integration: "sentry" },
        };
      }
      if (sole.kind === "many") {
        return {
          healthy: false,
          cause: "broken",
          reason:
            "more than one Sentry organization is connected; one Client Secret attributes deliveries to one",
          recovery: { kind: "none" },
        };
      }
      // Without the Client Secret every delivery is rejected with 401, and
      // Sentry does not retry a 4xx. That is a subscription that cannot
      // deliver, so it reads unhealthy here (ADR-0097 item 5) instead of
      // silently filling Sentry's delivery log with rejections. Only an
      // operator can set the env var, so there is no user-facing recovery and
      // the `none` recovery keeps this reason out of every user surface.
      if (!sentryWebhookSecretConfigured()) {
        return {
          healthy: false,
          cause: "broken",
          reason: "SENTRY_WEBHOOK_CLIENT_SECRET is not set, so every Sentry delivery is rejected",
          recovery: { kind: "none" },
        };
      }
      return { healthy: true };
    },
  },
};

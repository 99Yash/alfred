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
 * Sentry internal-integration webhooks (ADR-0097, #563).
 * The body names no organization, so the owner is the one active Sentry credential.
 * Two active credentials would need two secrets, so that case is refused.
 * `Request-ID` changes on each retry, so the dedup key is synthetic.
 * Known gap: nothing consumes `installation.deleted`, so health stays green after an uninstall.
 */

/**
 * `<type>:<identity>`, or `null`. The identity sits at a different path per type.
 * The type prefix keeps an issue's `created` apart from its alert.
 */
const sentryDeliveryKey: InboundSyntheticKey<"sentry"> = ({ payload, type, payloadHash }) => {
  switch (type) {
    case "error_created": {
      const eventId = getIdPath(payload, "data", "error", "event_id");

      return eventId ? `${type}:${eventId}` : null;
    }

    case "event_alert_triggered": {
      // One event can match two rules; the rule label keeps the alerts apart.
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
      // A transition can repeat on one issue (resolve, regress, resolve), and there
      // is no per-transition id. A retry re-sends the same body, so the digest
      // separates transitions. Rare cost: a retry whose issue changed is a duplicate.
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

  // No `action` is still a real delivery, as on GitHub.
  if (!action) return { kind: "raw", rawKind: resource };
  // Untyped kinds (`comment`, `metric_alert`) become raw as `<resource>.<action>`.
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

    if (sole.kind === "many") return { kind: "unowned", reason: "ambiguous", reference: null };

    // The signature is the whole attribution, so there is no reference to report.
    if (sole.kind === "none") return { kind: "unowned", reason: "no_match", reference: null };
    const { credential } = sole;

    return {
      kind: "owned",
      owner: {
        userId: credential.userId,
        credentialId: credential.id,
        accountRef: credential.accountId,
      },
    };
  },
  subscription: {
    async health(userId) {
      // Keep the secret check first. Readiness branches on the recovery kind, so a
      // `connect` verdict here would block the workflow and email the owner.
      // Without the secret every delivery gets 401 (ADR-0097 item 5).
      if (!sentryWebhookSecretConfigured()) {
        return {
          healthy: false,
          cause: "broken",
          reason: "SENTRY_WEBHOOK_CLIENT_SECRET is not set, so every Sentry delivery is rejected",
          recovery: { kind: "none" },
        };
      }

      // Same rule as `resolveOwner`, so health cannot be green while deliveries drop.
      const sole = await findSoleActiveCredential({ provider: "sentry" });

      if (sole.kind === "many") {
        return {
          healthy: false,
          cause: "broken",
          reason:
            "more than one Sentry organization is connected; one Client Secret attributes deliveries to one",
          recovery: { kind: "none" },
        };
      }

      if (sole.kind === "one" && sole.credential.userId === userId) return { healthy: true };

      return {
        healthy: false,
        cause: "never_connected",
        reason: "no Sentry organization is connected",
        recovery: { kind: "connect", integration: "sentry" },
      };
    },
  },
};

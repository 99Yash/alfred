import { eventDeliveryAccounts, type ProviderAvailability } from "@alfred/contracts";
import { pubSubOidcConfigFromEnv, readGmailWatchState } from "@alfred/integrations/google";
import type { AccountDeliveryHealthReader } from "../event-source-health";
import type { EventDeliveryHealth } from "../ingress/descriptor";
import { GMAIL_POLL_SWEEP_INTERVAL_MS } from "./gmail-delivery-policy";
import { readGmailDeliveryFacts, type GmailDeliveryFacts } from "./gmail-delivery-facts";

/** Gmail's delivery account space: `google` rows that prove Gmail is connected. */
const GMAIL_DELIVERY = eventDeliveryAccounts("gmail");

/** Older than three sweeps means the sweep itself is not running, not a quiet mailbox (#998). */
const GMAIL_EVENT_HEALTH_MAX_AGE_MS = 3 * GMAIL_POLL_SWEEP_INTERVAL_MS;

/** Delivery-path facts for one Gmail credential. */
export type GmailEventHealth = Pick<
  GmailDeliveryFacts,
  "cursorReady" | "coverageGap" | "lastSyncAt"
> & {
  receiverConfigured: boolean;
  topicMatches: boolean;
};

/** No live watch. A row with no ingestion state reads the same way. */
const WATCH_NOT_INSTALLED: EventDeliveryHealth = {
  healthy: false,
  // The row exists, so Gmail was connected and the watch has lapsed (ADR-0100).
  cause: "broken",
  reason: "reconnect Gmail or renew its watch",
  recovery: { kind: "connect", integration: GMAIL_DELIVERY.integration },
};

/**
 * Delivery health for one Gmail account (#976). No live watch: `connect`. Receiver not configured:
 * `none`, operator only. Coverage gap, no cursor, or stale sync: `retry`.
 */
function gmailAccountDeliveryHealth(
  row: ProviderAvailability,
  facts: GmailEventHealth | undefined,
  now: Date,
): EventDeliveryHealth {
  const watch = readGmailWatchState(row.metadata);

  if (!facts || !watch || new Date(watch.expiresAt).getTime() <= now.getTime()) {
    return WATCH_NOT_INSTALLED;
  }

  if (!facts.receiverConfigured || !facts.topicMatches) {
    return {
      healthy: false,
      cause: "broken",
      reason: "the push receiver is not configured for this watch",
      recovery: { kind: "none" },
    };
  }

  const stale =
    !facts.lastSyncAt || now.getTime() - facts.lastSyncAt.getTime() > GMAIL_EVENT_HEALTH_MAX_AGE_MS;

  if (facts.coverageGap || !facts.cursorReady || stale) {
    return {
      healthy: false,
      cause: "broken",
      reason: "retry after delivery coverage recovers",
      recovery: { kind: "retry" },
    };
  }

  return { healthy: true };
}

/** Pure per-row verdict over facts keyed by credential id. Tests pass facts directly. */
export function gmailAccountHealth(
  healthByCredential: ReadonlyMap<string, GmailEventHealth>,
  now: Date,
): (row: ProviderAvailability) => EventDeliveryHealth {
  return (row) => gmailAccountDeliveryHealth(row, healthByCredential.get(row.credentialId), now);
}

/** Gmail delivery health, for workflow trigger readiness only. */
export const readGmailEventHealth: AccountDeliveryHealthReader = async (userId, rows, now) => {
  const cursorByCredential = await readGmailDeliveryFacts(userId);
  const pushConfig = pubSubOidcConfigFromEnv();

  const receiverConfigured =
    Boolean(pushConfig.pushTopic) &&
    (pushConfig.nodeEnv !== "production" ||
      (Boolean(pushConfig.audience) && Boolean(pushConfig.expectedServiceAccount)));

  const healthByCredential = new Map(
    (rows.get(GMAIL_DELIVERY.provider) ?? []).map(
      ({ credentialId, metadata }): [string, GmailEventHealth] => {
        const cursor = cursorByCredential.get(credentialId);
        const watchTopic = readGmailWatchState(metadata)?.topic;

        return [
          credentialId,
          {
            receiverConfigured,
            topicMatches: Boolean(watchTopic && watchTopic === pushConfig.pushTopic),
            cursorReady: cursor?.cursorReady ?? false,
            coverageGap: cursor?.coverageGap ?? false,
            lastSyncAt: cursor?.lastSyncAt ?? null,
          },
        ];
      },
    ),
  );

  return gmailAccountHealth(healthByCredential, now);
};

import { eventDeliveryAccounts, type ProviderAvailability } from "@alfred/contracts";
import { pubSubOidcConfigFromEnv, readGmailWatchState } from "@alfred/integrations/google";
import {
  GMAIL_POLL_SWEEP_INTERVAL_MS,
  readGmailDeliveryFacts,
  type GmailDeliveryFacts,
} from "@alfred/assistant/connections";
import type { EventDeliveryHealth } from "@alfred/assistant/connections/ingress";
import type { AccountDeliveryHealthReader } from "./event-source-health";

/** The account space Gmail events deliver per: `google` rows that prove Gmail connected. */
const GMAIL_DELIVERY = eventDeliveryAccounts("gmail");

/**
 * A watch whose last successful sync is older than three sweeps is degraded, not
 * quiet: the poll-fallback sweep syncs every credential once per cadence, so
 * three misses means the sweep itself is not running (#998 keeps the ratio).
 */
const GMAIL_EVENT_HEALTH_MAX_AGE_MS = 3 * GMAIL_POLL_SWEEP_INTERVAL_MS;

/** The five facts about one credential's Gmail delivery path, as the ingestion state records them. */
export type GmailEventHealth = Pick<
  GmailDeliveryFacts,
  "cursorReady" | "coverageGap" | "lastSyncAt"
> & {
  receiverConfigured: boolean;
  topicMatches: boolean;
};

/**
 * No live watch on the account: the user reconnects Gmail or renews the watch.
 * A row with no ingestion state reads the same way, because it has no watch to
 * deliver from.
 */
const WATCH_NOT_INSTALLED: EventDeliveryHealth = {
  healthy: false,
  reason: "reconnect Gmail or renew its watch",
  recovery: { kind: "connect", integration: GMAIL_DELIVERY.integration },
};

/**
 * Delivery health for one Gmail account (#976). A live watch is a precondition
 * for every other fact: without one the verdict is `connect`, whatever the
 * cursor says. With one, a receiver the server did not configure is `none`
 * (only an operator can fix it), and a coverage gap, a missing cursor, or a
 * stale sync is `retry` (time restores it).
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
      reason: "the push receiver is not configured for this watch",
      recovery: { kind: "none" },
    };
  }
  const stale =
    !facts.lastSyncAt || now.getTime() - facts.lastSyncAt.getTime() > GMAIL_EVENT_HEALTH_MAX_AGE_MS;
  if (facts.coverageGap || !facts.cursorReady || stale) {
    return {
      healthy: false,
      reason: "retry after delivery coverage recovers",
      recovery: { kind: "retry" },
    };
  }
  return { healthy: true };
}

/**
 * The pure half of Gmail's account-grain entry: the per-row verdict over facts
 * gathered by credential id. `readGmailEventHealth` gathers the facts; the
 * readiness tests supply them directly.
 */
export function gmailAccountHealth(
  healthByCredential: ReadonlyMap<string, GmailEventHealth>,
  now: Date,
): (row: ProviderAvailability) => EventDeliveryHealth {
  return (row) => gmailAccountDeliveryHealth(row, healthByCredential.get(row.credentialId), now);
}

/** Read Gmail delivery health only for workflow trigger readiness. */
export const readGmailEventHealth: AccountDeliveryHealthReader = async (
  userId,
  availability,
  now,
) => {
  const cursorByCredential = await readGmailDeliveryFacts(userId);
  const pushConfig = pubSubOidcConfigFromEnv();
  const receiverConfigured =
    Boolean(pushConfig.pushTopic) &&
    (pushConfig.nodeEnv !== "production" ||
      (Boolean(pushConfig.audience) && Boolean(pushConfig.expectedServiceAccount)));
  const healthByCredential = new Map(
    (availability.providers.get(GMAIL_DELIVERY.provider) ?? []).map(
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

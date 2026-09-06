import {
  GOOGLE_SCOPE,
  getPath,
  getStringPath,
  type EventDeliveryHealth,
  type EventSourceHealth,
  type IntegrationAvailabilitySnapshot,
  type ProviderAvailability,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { ingestionState } from "@alfred/db/schemas";
import { pubSubOidcConfigFromEnv, readGmailWatchState } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";

/** A watch whose last successful sync is older than this is degraded, not quiet. */
export const GMAIL_EVENT_HEALTH_MAX_AGE_MS = 15 * 60_000;

/** The five facts about one credential's Gmail delivery path, as the ingestion state records them. */
export interface GmailEventHealth {
  receiverConfigured: boolean;
  topicMatches: boolean;
  cursorReady: boolean;
  coverageGap: boolean;
  lastSyncAt: Date | null;
}

/**
 * No live watch on the account: the user reconnects Gmail or renews the watch.
 * This is also the `unselected` verdict, because a trigger that names no
 * account, or one the snapshot does not hold, has no watch to deliver from.
 */
const WATCH_NOT_INSTALLED: EventDeliveryHealth = {
  healthy: false,
  reason: "reconnect Gmail or renew its watch",
  recovery: { kind: "connect", integration: "gmail" },
};

/**
 * Delivery health for one Gmail account (#976). A live watch is a precondition
 * for every other fact: without one the verdict is `connect`, whatever the
 * cursor says. With one, a receiver the server did not configure is `none`
 * (only an operator can fix it), and a coverage gap, a missing cursor, or a
 * stale sync is `retry` (time restores it).
 */
export function gmailAccountDeliveryHealth(
  row: ProviderAvailability,
  facts: GmailEventHealth,
  now: Date,
): EventDeliveryHealth {
  const watch =
    row.status === "active" && row.scopes.has(GOOGLE_SCOPE.gmail.readonly)
      ? readGmailWatchState(row.metadata)
      : null;
  if (!watch || new Date(watch.expiresAt).getTime() <= now.getTime()) return WATCH_NOT_INSTALLED;
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
 * Gmail's entry in the event-source health map: account grain over the
 * `google` credential rows, keyed by durable `accountId`. A row with no facts
 * has no ingestion state to deliver from and reads as `connect`.
 */
export function gmailEventSourceHealth(
  availability: IntegrationAvailabilitySnapshot,
  healthByCredential: ReadonlyMap<string, GmailEventHealth>,
  now: Date,
): EventSourceHealth {
  const accounts = new Map(
    (availability.providers.get("google") ?? []).map((row): [string, EventDeliveryHealth] => {
      const facts = healthByCredential.get(row.credentialId);
      return [
        row.accountId,
        facts ? gmailAccountDeliveryHealth(row, facts, now) : WATCH_NOT_INSTALLED,
      ];
    }),
  );
  return { grain: "account", provider: "google", accounts, unselected: WATCH_NOT_INSTALLED };
}

/** Read Gmail delivery health only for workflow trigger readiness. */
export async function readGmailEventHealth(
  userId: string,
  availability: IntegrationAvailabilitySnapshot,
  now: Date,
): Promise<EventSourceHealth> {
  const rows = await db()
    .select({
      credentialId: ingestionState.credentialId,
      state: ingestionState.state,
      lastSyncAt: ingestionState.lastSyncAt,
    })
    .from(ingestionState)
    .where(
      and(
        eq(ingestionState.userId, userId),
        eq(ingestionState.provider, "google"),
        eq(ingestionState.stream, "messages"),
      ),
    );
  const cursorByCredential = new Map(rows.map((row) => [row.credentialId, row]));
  const pushConfig = pubSubOidcConfigFromEnv();
  const receiverConfigured =
    Boolean(pushConfig.pushTopic) &&
    (pushConfig.nodeEnv !== "production" ||
      (Boolean(pushConfig.audience) && Boolean(pushConfig.expectedServiceAccount)));
  const healthByCredential = new Map(
    (availability.providers.get("google") ?? []).map(
      ({ credentialId, metadata }): [string, GmailEventHealth] => {
        const cursor = cursorByCredential.get(credentialId);
        const watchTopic = readGmailWatchState(metadata)?.topic;
        return [
          credentialId,
          {
            receiverConfigured,
            topicMatches: Boolean(watchTopic && watchTopic === pushConfig.pushTopic),
            cursorReady: Boolean(getStringPath(cursor?.state, "historyId")),
            coverageGap: getPath(cursor?.state, "coverageGap") === true,
            lastSyncAt: cursor?.lastSyncAt ?? null,
          },
        ];
      },
    ),
  );
  return gmailEventSourceHealth(availability, healthByCredential, now);
}

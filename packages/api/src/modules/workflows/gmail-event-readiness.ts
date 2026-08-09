import { getPath, getStringPath, type IntegrationAvailabilitySnapshot } from "@alfred/contracts";
import { db } from "@alfred/db";
import { ingestionState } from "@alfred/db/schemas";
import { readGmailWatchState } from "@alfred/integrations/google";
import { and, eq } from "drizzle-orm";
import { pubSubOidcConfigFromEnv } from "../integrations/gmail-push-config";

export interface GmailEventHealth {
  receiverConfigured: boolean;
  topicMatches: boolean;
  cursorReady: boolean;
  coverageGap: boolean;
  lastSyncAt: Date | null;
}

/** Read Gmail delivery health only for workflow trigger readiness. */
export async function readGmailEventHealth(
  userId: string,
  availability: IntegrationAvailabilitySnapshot,
): Promise<ReadonlyMap<string, GmailEventHealth>> {
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
  return new Map(
    (availability.providers.get("google") ?? []).map(({ credentialId, metadata }) => {
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
    }),
  );
}

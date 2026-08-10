import { toMessage } from "@alfred/contracts";
import { publishDomainEvent } from "@alfred/assistant/triggers";

type DomainEventPublisher = typeof publishDomainEvent;

/**
 * Publish the completed connection occurrence without naming its consumers.
 *
 * Best-effort: a publication failure must not bounce the user to an OAuth error
 * page, so it is swallowed with a warn. The Google callback route calls this after
 * the credential is already persisted, so the connection is usable either way —
 * only the post-connect fan-out (cold-start enrichment and friends) is lost, and
 * that is recoverable on the next connect.
 */
export async function publishGoogleCallbackCompleted(
  userId: string,
  credentialId: string,
  publish: DomainEventPublisher = publishDomainEvent,
): Promise<void> {
  try {
    await publish({
      userId,
      source: "google.oauth.callback",
      type: "completed",
      eventId: `google.callback:${credentialId}`,
    });
  } catch (err) {
    console.warn(
      `[google.callback] failed to publish completed event for ${userId}:`,
      toMessage(err),
    );
  }
}

import { toMessage } from "@alfred/contracts";
import { publishDomainEvent } from "@alfred/assistant/triggers";

type DomainEventPublisher = typeof publishDomainEvent;

/**
 * Best-effort: the credential is already saved, so a failure must not show an OAuth error.
 * Only the post-connect fan-out is lost, and the next connect retries it.
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

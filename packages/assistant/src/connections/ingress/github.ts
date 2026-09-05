import { isEventTypeForSource } from "@alfred/contracts";
import {
  findCredentialByInstallationId,
  githubInstallationId,
  listGithubCredentials,
  verifyWebhookSignature,
} from "@alfred/integrations/github";
import type { InboundSourceDescriptor } from "./descriptor";

/**
 * GitHub App activity (ADR-0052, ADR-0097). GitHub signs the raw body with the
 * App's webhook secret (`X-Hub-Signature-256`), names the event in
 * `X-GitHub-Event`, and sends a delivery UUID in `X-GitHub-Delivery` that is
 * stable across redeliveries and manual replays, so it is the dedup key. The
 * owner is the credential whose `installation_id` matches `installation.id`.
 *
 * Deliveries reach the deployed server only: the App's hook URL is the Railway
 * domain, so localhost cannot receive them.
 */
export const githubInboundSource: InboundSourceDescriptor<"github"> = {
  slug: "github",
  verify: (raw, headers) => verifyWebhookSignature(raw, headers.get("x-hub-signature-256")),
  dedup: { kind: "delivery_id", header: "x-github-delivery" },
  project: (_payload, headers) => {
    const event = headers.get("x-github-event");
    if (!event) return { kind: "ignore", reason: "no-event-header" };
    // GitHub pings once on subscription; a 200 is what makes the App show green.
    if (event === "ping") return { kind: "ignore", reason: "ping" };
    return isEventTypeForSource("github", event)
      ? { kind: "event", type: event }
      : { kind: "ignore", reason: `unsubscribed:${event}` };
  },
  resolveOwner: async (payload) => {
    const installationId = githubInstallationId(payload);
    if (!installationId) return null;
    const credential = await findCredentialByInstallationId(installationId);
    return credential
      ? { userId: credential.userId, credentialId: credential.id, accountRef: credential.accountId }
      : null;
  },
  subscription: {
    async health(userId) {
      const credentials = await listGithubCredentials(userId);
      const installed = credentials.some(
        (credential) => credential.status === "active" && Boolean(credential.installationId),
      );
      return installed
        ? { healthy: true }
        : {
            healthy: false,
            reason: "no active GitHub App installation is connected",
            recovery: { kind: "connect", integration: "github" },
          };
    },
  },
};

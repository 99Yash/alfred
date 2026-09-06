import { getStringPath, isEventTypeForSource } from "@alfred/contracts";
import { githubInstallationId, verifyWebhookSignature } from "@alfred/integrations/github";
import {
  findActiveCredentialByInstallationId,
  hasActiveInstallationCredential,
} from "@alfred/integrations/shared";
import type { InboundSourceDescriptor } from "./descriptor";
import { describeGithubReceipt } from "./github-description";

/**
 * GitHub App activity (ADR-0052, ADR-0097). GitHub signs the raw body with the
 * App's webhook secret (`X-Hub-Signature-256`), names the event in
 * `X-GitHub-Event`, and sends a delivery UUID in `X-GitHub-Delivery` that is
 * stable across redeliveries and manual replays, so it is the dedup key. The
 * owner is the credential whose `installation_id` matches `installation.id`.
 *
 * An event the `github` entry does not name is a raw receipt (ADR-0097 item 9)
 * under GitHub's own kind, `<event>.<action>` (`issue_comment.created`) or the
 * bare event when the body carries no `action` (`status`). Only `ping` and a
 * delivery with no event header are dropped.
 *
 * Deliveries reach the deployed server only: the App's hook URL is the Railway
 * domain, so localhost cannot receive them.
 */
export const githubInboundSource: InboundSourceDescriptor<"github"> = {
  slug: "github",
  describe: describeGithubReceipt,
  verify: (raw, headers) => verifyWebhookSignature(raw, headers.get("x-hub-signature-256")),
  dedup: { kind: "delivery_id", header: "x-github-delivery" },
  project: (payload, headers) => {
    const event = headers.get("x-github-event");
    if (!event) return { kind: "ignore", reason: "no-kind-header" };
    // GitHub pings once on subscription; a 200 is what makes the App show green.
    if (event === "ping") return { kind: "ignore", reason: "ping" };
    if (isEventTypeForSource("github", event)) return { kind: "event", type: event };
    const action = getStringPath(payload, "action");
    return { kind: "raw", rawKind: action ? `${event}.${action}` : event };
  },
  resolveOwner: async (payload) => {
    const installationId = githubInstallationId(payload);
    if (!installationId) return null;
    const credential = await findActiveCredentialByInstallationId({
      provider: "github",
      installationId,
    });
    return credential
      ? { userId: credential.userId, credentialId: credential.id, accountRef: credential.accountId }
      : null;
  },
  subscription: {
    async health(userId) {
      const installed = await hasActiveInstallationCredential({ userId, provider: "github" });
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

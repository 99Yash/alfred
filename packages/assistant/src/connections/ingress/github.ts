import {
  credentialSatisfies,
  getStringPath,
  INTEGRATIONS,
  isEventTypeForSource,
} from "@alfred/contracts";
import { githubInstallationId, verifyWebhookSignature } from "@alfred/integrations/github";
import { findActiveCredentialByInstallationId } from "@alfred/integrations/shared";
import type { InboundSourceDescriptor } from "./descriptor";
import { describeGithubReceipt } from "./github-description";

/** GitHub's connected rule (ADR-0093). */
const GITHUB_CREDENTIAL = INTEGRATIONS.github.credential;

/**
 * GitHub App activity (ADR-0052, ADR-0097). `X-GitHub-Delivery` is stable across
 * redeliveries, so it is the dedup key. The owner matches on `installation.id`.
 * The hook URL is the deployed domain, so localhost receives nothing.
 */
export const githubInboundSource: InboundSourceDescriptor<"github"> = {
  slug: "github",
  describe: describeGithubReceipt,
  verify: (raw, headers) => verifyWebhookSignature(raw, headers.get("x-hub-signature-256")),
  dedup: { kind: "delivery_id", header: "x-github-delivery" },
  project: (payload, headers) => {
    const event = headers.get("x-github-event");

    if (!event) return { kind: "ignore", reason: "no-kind-header" };

    // A 200 on the subscription ping makes the App show green.
    if (event === "ping") return { kind: "ignore", reason: "ping" };

    if (isEventTypeForSource("github", event)) return { kind: "event", type: event };
    const action = getStringPath(payload, "action");

    return { kind: "raw", rawKind: action ? `${event}.${action}` : event };
  },
  resolveOwner: async (payload) => {
    const installationId = githubInstallationId(payload);

    // No `installation.id` means this is not an App delivery.
    if (!installationId) return { kind: "unowned", reason: "no_match", reference: null };

    const credential = await findActiveCredentialByInstallationId({
      provider: "github",
      installationId,
    });

    // Report the id (#1033): a stale installation id on an active row was a real incident.
    return credential
      ? {
          kind: "owned",
          owner: {
            userId: credential.userId,
            credentialId: credential.id,
            accountRef: credential.accountId,
          },
        }
      : {
          kind: "unowned",
          reason: "no_match",
          reference: { column: "installation_id", value: installationId },
        };
  },
  subscription: {
    async health(_userId, rows) {
      const github = rows.get("github") ?? [];

      if (github.some((row) => credentialSatisfies(GITHUB_CREDENTIAL, row))) {
        return { healthy: true };
      }

      // An `installation_id` on any row proves deliveries once flowed, so this is a break (ADR-0100).
      // A classic-OAuth row without one never received a delivery; that is not a loss.
      if (github.some((row) => row.installationId !== null)) {
        return {
          healthy: false,
          cause: "broken",
          reason: "the GitHub App installation for this account is no longer active",
          recovery: { kind: "connect", integration: "github" },
        };
      }

      return {
        healthy: false,
        cause: "never_connected",
        reason: "no GitHub App installation is connected",
        recovery: { kind: "connect", integration: "github" },
      };
    },
  },
};

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

/** GitHub's connected rule (ADR-0093), read once. */
const GITHUB_CREDENTIAL = INTEGRATIONS.github.credential;

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
    // Every App delivery carries `installation.id`. A body without one is not
    // an App delivery, so there is no reference to name in the report either.
    if (!installationId) return { kind: "unowned", reason: "no_match", reference: null };
    const credential = await findActiveCredentialByInstallationId({
      provider: "github",
      installationId,
    });
    // The installation id goes on the drop report (#1033). It is the exact
    // value the reader compares against `integration_credentials.installation_id`,
    // and the production incident was one active row whose id no longer
    // matched it.
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
      // The connected rule (ADR-0093) is the same one the tile reads: an active
      // row that carries an `installation_id`. Reading it here, off the
      // caller's rows, is what keeps the tile and this verdict from disagreeing.
      if (github.some((row) => credentialSatisfies(GITHUB_CREDENTIAL, row))) {
        return { healthy: true };
      }
      // `installation_id` on ANY row, at any status, is the fact that separates
      // the two unhealthy answers (ADR-0100). It is a durable record that this
      // user once completed Install & Authorize, so App deliveries did flow and
      // have stopped: the row was revoked, expired, or the installation was
      // removed on GitHub's side. An alert speaks for that user.
      //
      // A row with no installation id at all is NOT a loss. A classic-OAuth row
      // that predates the App migration (ADR-0052) never received one delivery,
      // so "Alfred stopped receiving GitHub activity" would be false, and
      // `GithubReconnectBanner` already names that row and offers that repair.
      // Reading "any row at all" here is what made this verdict claim a break
      // that never happened, on the one state the deployment actually holds.
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

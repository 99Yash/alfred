import { getStringPath, isNonEmptyString, type JsonObject } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { z } from "zod";

import { hmacSha256Hex, signatureMatches } from "../shared/webhook";

/**
 * The wire facts of a Sentry internal-integration webhook, as the ingress
 * descriptor needs them (ADR-0097; research in
 * `docs/research/sentry-push-surface-and-autofix.md`):
 *
 * - `Sentry-Hook-Signature` is HMAC-SHA256 hex over the exact transmitted body
 *   (Python `json.dumps` output), keyed with the integration's Client Secret.
 *   `Sentry-Hook-Timestamp` is not in the signed bytes, and `Request-ID` is a
 *   fresh uuid per send, so neither is a replay window or a dedup key.
 * - `Sentry-Hook-Resource` names the resource (`error`, `event_alert`, `issue`,
 *   `seer`, `installation`, `comment`, …); the body's `action` completes it.
 * - `installation.uuid` at the payload root is the installation the connect
 *   flow stored in `integration_credentials.installation_id`.
 */

/** Sentry's per-delivery headers, spelled once. `Headers.get` is case-insensitive. */
export const SENTRY_HOOK_HEADERS = {
  signature: "sentry-hook-signature",
  resource: "sentry-hook-resource",
} as const;

/** Whether `SENTRY_WEBHOOK_CLIENT_SECRET` is set. Without it no delivery can be verified, so the subscription is not healthy. */
export function sentryWebhookSecretConfigured(): boolean {
  return Boolean(serverEnv().SENTRY_WEBHOOK_CLIENT_SECRET);
}

/**
 * The three answers a signature check can give. `no_secret` is kept apart from
 * `mismatch` so the ingress log names a missing env var as such, instead of
 * sending an operator to hunt for a key mismatch that does not exist.
 */
export type SentryWebhookVerdict = "verified" | "no_secret" | "mismatch";

/**
 * Verify `Sentry-Hook-Signature` over the RAW request body. A server without
 * `SENTRY_WEBHOOK_CLIENT_SECRET` rejects every delivery: an unverifiable body
 * is never stored, and the connect flow does not depend on the secret.
 */
export function verifySentryWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): SentryWebhookVerdict {
  const secret = serverEnv().SENTRY_WEBHOOK_CLIENT_SECRET;
  if (!secret) return "no_secret";
  return signatureMatches(hmacSha256Hex(secret, rawBody), signatureHeader)
    ? "verified"
    : "mismatch";
}

/** The installation uuid the delivery names, or `null` when the payload carries none. */
export function sentryInstallationUuid(payload: JsonObject): string | null {
  const uuid = getStringPath(payload, "installation", "uuid");
  return isNonEmptyString(uuid) ? uuid : null;
}

const seerPullRequestSchema = z.object({
  pull_request: z.object({
    pr_number: z.number().int(),
    pr_url: z.url(),
    pr_id: z.union([z.number(), z.string()]).optional(),
  }),
  repo_name: z.string(),
  provider: z.string(),
});

/**
 * The `seer.pr_created` body (docs.sentry.io, verified 2026-09-05): one Autofix
 * run, the Sentry issue (`group_id`) it fixed, and one pull request per
 * repository it touched. `parseSeerPullRequestsCreated` is the one door the
 * verification rung (#567) reads a receipt through; nothing else interprets
 * Seer bodies, and the schema stays private so a second door cannot grow.
 */
const seerPullRequestsCreatedSchema = z.object({
  action: z.literal("pr_created"),
  data: z.object({
    run_id: z.union([z.number(), z.string()]),
    group_id: z.union([z.number(), z.string()]),
    pull_requests: z.array(seerPullRequestSchema).min(1),
  }),
});

export type SeerPullRequestsCreated = z.infer<typeof seerPullRequestsCreatedSchema>;

/** Parse a stored `sentry.seer_pr_created` receipt body, or `null` when it is not one. */
export function parseSeerPullRequestsCreated(payload: unknown): SeerPullRequestsCreated | null {
  const parsed = seerPullRequestsCreatedSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

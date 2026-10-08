import { serverEnv } from "@alfred/env/server";
import { z } from "zod";

import { hmacSha256Hex, signatureMatches } from "../shared/webhook";

/**
 * Sentry internal-integration webhooks (ADR-0097, `docs/research/sentry-push-surface-and-autofix.md`).
 * - The signature is HMAC-SHA256 hex over the exact body, keyed by the Client Secret.
 *   The timestamp is not signed and `Request-ID` is new per send: no replay window, no dedup key.
 * - `Sentry-Hook-Resource` names the resource (`issue`, `event_alert`, `seer`); the body's `action` completes it.
 * - The body names no organization, so a verified delivery goes to the one active Sentry credential.
 */

/** `Headers.get` is case-insensitive. */
export const SENTRY_HOOK_HEADERS = {
  signature: "sentry-hook-signature",
  resource: "sentry-hook-resource",
} as const;

/** Without the secret no delivery verifies, so the subscription is not healthy. */
export function sentryWebhookSecretConfigured(): boolean {
  return Boolean(serverEnv().SENTRY_WEBHOOK_CLIENT_SECRET);
}

/** `no_secret` is separate so the log names a missing env var, not a key mismatch. */
export type SentryWebhookVerdict = "verified" | "no_secret" | "mismatch";

/** Verify over the raw body. Without the secret, every delivery is rejected. */
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
 * `seer.pr_created` (checked 2026-09-05): one Autofix run, its issue (`group_id`),
 * one PR per repo. Private: read it only through `parseSeerPullRequestsCreated`.
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

export function parseSeerPullRequestsCreated(payload: unknown): SeerPullRequestsCreated | null {
  const parsed = seerPullRequestsCreatedSchema.safeParse(payload);

  return parsed.success ? parsed.data : null;
}

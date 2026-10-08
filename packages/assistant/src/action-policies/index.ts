/**
 * Per-user action policy: what the dispatcher may do without asking (ADR-0034).
 * One row per user, one cache per instance, one Redis channel to bust the caches.
 * Importing this barrel opens no connection and starts no timer; both are lazy.
 * The subscriber counts as started only after `psubscribe` resolves, so a failed start can retry.
 * A dropped bust leaves one stale entry until the next bust or restart; it never fails the mutation.
 * The publisher's "command" connection rejects on an unreachable Redis. The subscriber
 * has no command timeout, so a Redis that accepts and never answers can hang it.
 * Not guaranteed: two concurrent starts can both subscribe. Nothing calls them concurrently today.
 * Test cache helpers are on the `test-support` subpath, not here.
 */

import type { IntegrationRules } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userActionPolicies } from "@alfred/db/schemas";
import { sql } from "drizzle-orm";
import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "./resolve";

export {
  DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
  getResolvedPolicy,
  resolvePolicyMode,
  resolveApprovalNotifyDelayMs,
  bustPolicyCache,
  publishPolicyBust,
  startPolicyBustSubscriber,
  stopPolicyBustSubscriber,
  type ResolvedPolicy,
} from "./resolve";

const DEFAULT_INTEGRATION_RULES = {
  system: { mode: "autonomy" },
} satisfies IntegrationRules;

export async function ensureDefaultActionPolicyForUser(userId: string): Promise<void> {
  await db()
    .insert(userActionPolicies)
    .values({
      userId,
      defaultMode: "gated",
      integrationRules: DEFAULT_INTEGRATION_RULES,
      approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
    })
    .onConflictDoUpdate({
      target: userActionPolicies.userId,
      set: {
        // Only touch `updated_at`, so user changes survive.
        updatedAt: sql`now()`,
      },
    });
}

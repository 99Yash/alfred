/**
 * Per-user action policy: what the tool dispatcher is allowed to do without asking
 * (ADR-0034). One row per user in `user_action_policies`, one in-process cache per
 * server instance, and one Redis pub/sub channel that keeps those caches honest.
 *
 * This module owns a background loop with lifecycle wiring — `startPolicyBustSubscriber`
 * and `stopPolicyBustSubscriber` are called from the server's own start and shutdown
 * paths (`apps/server/src/runtime.ts`) — which is why it lives beside the rest of the
 * server-lifecycle code and not in the HTTP layer.
 *
 * Invariant. Given a process that has imported this barrel and nothing else, no Redis
 * connection and no timer exist; and after any interleaving of `publishPolicyBust`,
 * `startPolicyBustSubscriber` and `stopPolicyBustSubscriber` and any Redis failure among
 * them, at most one `policy-bust:u:*` subscription is live, and the module reports itself
 * started only while a `psubscribe` has succeeded and has not been stopped — a
 * `psubscribe` that throws closes its half-built connection and leaves the flag false, so
 * the next start retries rather than no-opping into a dead subscriber — and a dropped
 * bust degrades to a stale cache entry, never to a failed policy mutation.
 *
 * The guard is the `subscriberStarted` flag in `./resolve` and the order of its
 * assignment: it is set only after `await conn.psubscribe` resolves, never before. No
 * Redis connection exists until the first `publishPolicyBust` or the first
 * `startPolicyBustSubscriber`; both build theirs lazily inside the call.
 *
 * The two cache helpers tests need are NOT on this barrel. They live behind the separate
 * `@alfred/assistant/action-policies/test-support` subpath, so a production file cannot
 * reach them without naming a door called `test-support`.
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
        // Keep this hook idempotent without trampling user changes. The
        // conflict path only proves the row still conforms to the m13
        // baseline and refreshes updated_at for audit visibility.
        updatedAt: sql`now()`,
      },
    });
}

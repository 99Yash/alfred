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
 * connection and no timer exists. For a single sequential caller of
 * `startPolicyBustSubscriber` and `stopPolicyBustSubscriber` — which is what the server is,
 * one start at boot and one stop at shutdown — the module reports itself started only after
 * an `await conn.psubscribe` has resolved and has not been stopped since. The guard is the
 * `subscriberStarted` flag in `./resolve` and the order of its assignment: it is set after
 * that await, never before, so a `psubscribe` that throws closes its half-built connection,
 * leaves the flag false and lets the next start retry instead of no-opping into a dead
 * subscriber. And because the cache holds no TTL, a bust that is never delivered bounds to
 * one stale entry per user on the instances that missed it, until the next delivered bust
 * for that user or a process restart. A dropped bust degrades to that stale cache entry,
 * never to a failed policy mutation: both connections are `"command"` connections
 * (`createRedisConnection` in `@alfred/db/redis`), whose numeric `maxRetriesPerRequest` and
 * `commandTimeout` make a command against an unreachable Redis reject within a bounded wait
 * instead of queueing offline forever, and `publishPolicyBust` catches that rejection rather
 * than surfacing it on the mutation.
 *
 * Deliberately NOT guaranteed, so nobody builds on it. Two concurrent
 * `startPolicyBustSubscriber` calls can each pass the `if (subscriberStarted) return;`
 * check and open their own `policy-bust:u:*` subscription — there is no in-flight memo —
 * and a `stopPolicyBustSubscriber` that races an in-flight start can be overtaken by that
 * start's flag assignment. Nothing calls them concurrently today.
 *
 * No Redis connection exists until the first `publishPolicyBust` or the first
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

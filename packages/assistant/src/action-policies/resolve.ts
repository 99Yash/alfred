/**
 * Policy resolution with a per-process cache (ADR-0034).
 * The dispatcher reads the policy on every tool call, so each instance caches the row per user.
 * A policy update publishes on `policy-bust:u:<userId>` and every instance drops its entry.
 * The cache holds the row, not the mode, because the mode depends on the tool.
 * It holds a Promise, so a burst of reads for one user makes one DB read.
 */

import type { PolicyMode, ToolName } from "@alfred/contracts";
import { integrationFromToolName, resolveToolMode } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userActionPolicies, type UserActionPolicy } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import type IORedis from "ioredis";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { logger } from "@alfred/logging";

/** The four policy columns the resolver reads. */
export type ResolvedPolicy = Pick<
  UserActionPolicy,
  "userId" | "defaultMode" | "integrationRules" | "approvalNotifyDelayMs"
>;

/**
 * The policy a user has before they change anything: `gated` (ADR-0034) and the `system`
 * autonomy seed (ADR-0040). The signup hook, the no-row read, and every sync mutator insert
 * take it from here. Here, not in `index.ts`, so the barrel imports it without a cycle.
 * It returns fresh objects, so a cached fallback never shares an object with an insert.
 */
export function defaultActionPolicy(userId: string): ResolvedPolicy {
  return {
    userId,
    defaultMode: "gated",
    // `system` is a backstop: `resolvePolicyMode` never gates `system.*`.
    integrationRules: { system: { mode: "autonomy" } },
    // Wait before the fallback approval email.
    approvalNotifyDelayMs: 5 * 60 * 1000,
  };
}

const POLICY_BUST_CHANNEL_PREFIX = "policy-bust:u:";

const POLICY_BUST_PATTERN = `${POLICY_BUST_CHANNEL_PREFIX}*`;

function bustChannel(userId: string): string {
  return `${POLICY_BUST_CHANNEL_PREFIX}${userId}`;
}

const cache = new Map<string, Promise<ResolvedPolicy>>();

async function loadPolicy(userId: string): Promise<ResolvedPolicy> {
  const rows = await db()
    .select({
      userId: userActionPolicies.userId,
      defaultMode: userActionPolicies.defaultMode,
      integrationRules: userActionPolicies.integrationRules,
      approvalNotifyDelayMs: userActionPolicies.approvalNotifyDelayMs,
    })
    .from(userActionPolicies)
    .where(eq(userActionPolicies.userId, userId))
    .limit(1);

  const row = rows[0];

  if (row) {
    return {
      userId: row.userId,
      defaultMode: row.defaultMode,
      integrationRules: row.integrationRules,
      approvalNotifyDelayMs: row.approvalNotifyDelayMs,
    };
  }

  // No row: a legacy user or a race with signup. Return the defaults the hook writes.
  // Do not write a row here; that would race the hook.
  return defaultActionPolicy(userId);
}

export async function getResolvedPolicy(userId: string): Promise<ResolvedPolicy> {
  const cached = cache.get(userId);

  if (cached) return cached;

  const pending = loadPolicy(userId).catch((err) => {
    // Do not cache a failed read; the next caller retries.
    cache.delete(userId);
    throw err;
  });

  cache.set(userId, pending);

  return pending;
}

/**
 * Read order: `system.*`, then tool override, then integration mode, then user default (ADR-0034).
 * `system.*` returns `autonomy` before the row is read (ADR-0040 D5), so no data bug
 * or user toggle can gate it. The seeded `integrationRules.system` is only a second line.
 * `system.*` can still stage on the ADR-0069 `high`-tier floor, which `toolRequiresApproval` adds.
 */
export async function resolvePolicyMode(userId: string, toolName: ToolName): Promise<PolicyMode> {
  const integration = integrationFromToolName(toolName);

  if (integration === "system") return "autonomy";

  const policy = await getResolvedPolicy(userId);

  return resolveToolMode(policy.integrationRules, toolName, policy.defaultMode);
}

export async function resolveApprovalNotifyDelayMs(userId: string): Promise<number> {
  const policy = await getResolvedPolicy(userId);

  return policy.approvalNotifyDelayMs;
}

/** Drop one user's cached row. */
export function bustPolicyCache(userId: string): void {
  cache.delete(userId);
}

/** Test-only. Production busts per user. */
export function clearPolicyCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only. Seed the cache so `getResolvedPolicy` makes no DB read.
 * The gate's approval floor reads `resolveApprovalNotifyDelayMs`, so a DB-free test needs this.
 */
export function _primePolicyCacheForTests(policy: ResolvedPolicy): void {
  cache.set(policy.userId, Promise.resolve(policy));
}

let publisher: BoundedRedis | undefined;

function getPublisher(): BoundedRedis {
  if (!publisher) publisher = createRedisConnection("command");

  return publisher;
}

/**
 * Tell every instance to drop its cached row for `userId`. Call after every
 * `user_action_policies` update. Uses one lazy publisher connection; the "command"
 * kind makes an unreachable Redis reject instead of hang.
 */
export async function publishPolicyBust(userId: string): Promise<void> {
  // Best-effort. The cache has no TTL, so a dropped bust leaves other instances
  // stale until the next bust or a restart. Fine for one user; add a TTL for multi-tenant.
  try {
    await getPublisher().publish(bustChannel(userId), "1");
  } catch (err) {
    logger.error(
      {
        userId,
        err,
      },
      "[action-policies] publishPolicyBust failed",
    );
  }
}

let subscriber: IORedis | undefined;

let subscriberStarted = false;

/**
 * Start the per-process subscriber. Idempotent. One PSUBSCRIBE on `policy-bust:u:*`
 * covers every user. `runtime/runtime.ts` starts it at boot.
 */
export async function startPolicyBustSubscriber(): Promise<void> {
  if (subscriberStarted) return;

  const conn = createRedisConnection("subscriber");
  conn.on("pmessage", (_pattern, channel, _message) => {
    if (!channel.startsWith(POLICY_BUST_CHANNEL_PREFIX)) return;
    const userId = channel.slice(POLICY_BUST_CHANNEL_PREFIX.length);

    if (userId.length === 0) return;
    bustPolicyCache(userId);
  });
  conn.on("error", (err) => {
    logger.error(
      {
        err,
      },
      "[action-policies] policy-bust subscriber error",
    );
  });

  try {
    await conn.psubscribe(POLICY_BUST_PATTERN);
  } catch (err) {
    // Do not latch on failure, or one Redis outage disables invalidation until restart.
    // Close the half-open connection and rethrow.
    try {
      await conn.quit();
    } catch {
      conn.disconnect();
    }

    throw err;
  }

  // Set these only after the subscription is live, so a concurrent caller retries.
  subscriber = conn;
  subscriberStarted = true;

  // A reconnect drops the subscription, and `autoResubscribe` is off because ioredis's
  // own resubscribe can crash the process. So resubscribe here, or edits go silently stale.
  // Registered after the first subscribe, so the first `ready` does not subscribe twice.
  conn.on("ready", () => {
    if (!subscriberStarted) return;
    conn.psubscribe(POLICY_BUST_PATTERN).catch((err: unknown) => {
      logger.error(
        {
          err,
        },
        "[action-policies] policy-bust re-subscribe after reconnect failed",
      );
    });
  });
}

/**
 * Stop the subscriber and drop the publisher handle. Idempotent.
 * `closeRedis()` closes the sockets; this clears module state for a restart in the same process.
 */
export async function stopPolicyBustSubscriber(): Promise<void> {
  if (subscriberStarted) {
    subscriberStarted = false;

    if (subscriber) {
      try {
        await subscriber.punsubscribe(POLICY_BUST_PATTERN);
      } catch {
        // The connection may already be closing.
      }

      subscriber = undefined;
    }
  }

  // So a re-init after shutdown opens a fresh connection.
  publisher = undefined;
}

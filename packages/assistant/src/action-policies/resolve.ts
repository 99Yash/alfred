/**
 * Policy resolution + in-process cache bust (m13 Phase 3a / ADR-0034).
 *
 * The dispatcher (Phase 3b) consults `resolvePolicyMode(userId, toolName)`
 * on every tool call. A DB round-trip per call is wasted in the steady
 * state, so each server instance keeps an in-process Map of resolved
 * policy rows keyed by `userId`. The API mutation that updates a user's
 * `user_action_policies` row publishes on `policy-bust:u:<userId>`;
 * every server instance subscribes to the channel pattern and drops the
 * stale entry on receive. ADR-0034 lists the channel as a sibling of
 * the outbox bus rather than a new outbox kind — pure ephemeral
 * invalidation, no replay semantics needed.
 *
 * Cache shape: we store the row, not the resolved mode, because the
 * resolved mode depends on the tool name. Resolution is trivial pure
 * code; the expensive part is the DB hit.
 *
 * Concurrent readers: cache stores a `Promise<ResolvedPolicy>` so a
 * burst of dispatches for an uncached user coalesces into one DB read.
 */

import type {
  IntegrationRule,
  IntegrationRules,
  IntegrationSlug,
  PolicyMode,
  ToolName,
} from "@alfred/contracts";
import { integrationFromToolName, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { userActionPolicies } from "@alfred/db/schemas";
import { eq } from "drizzle-orm";
import type IORedis from "ioredis";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { DEFAULT_APPROVAL_NOTIFY_DELAY_MS } from "../constants";

export { DEFAULT_APPROVAL_NOTIFY_DELAY_MS };

export interface ResolvedPolicy {
  userId: string;
  defaultMode: PolicyMode;
  integrationRules: IntegrationRules;
  approvalNotifyDelayMs: number;
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

  // No row yet — the signup hook should have inserted one (Phase 1c). A
  // missing row here means either a legacy user predating the hook or a
  // race with signup; resolve to the same defaults the hook would have
  // written so the dispatcher can still gate sensibly. Do NOT write a
  // row here — that would race the hook in the opposite direction. The
  // ensure-helper is idempotent and the next mutation will land a row.
  return {
    userId,
    defaultMode: "gated",
    integrationRules: { system: { mode: "autonomy" } },
    approvalNotifyDelayMs: DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
  };
}

export async function getResolvedPolicy(userId: string): Promise<ResolvedPolicy> {
  const cached = cache.get(userId);
  if (cached) return cached;

  const pending = loadPolicy(userId).catch((err) => {
    // Don't poison the cache on a transient read failure — drop the
    // entry so the next caller retries.
    cache.delete(userId);
    throw err;
  });
  cache.set(userId, pending);
  return pending;
}

function pickRule(rules: IntegrationRules, slug: IntegrationSlug): IntegrationRule | undefined {
  return rules[slug];
}

/**
 * Resolve the policy mode for a `(userId, toolName)` pair. Read order:
 * `system.*` → tool override → integration mode → user default (ADR-0034 /
 * dispatcher spec for the last three).
 *
 * `system.*` answers `autonomy` structurally, and it answers BEFORE the policy
 * row is read. That order is the whole defense, and it is why the rule lives
 * here rather than at a call site (ADR-0040 decision 5, amended 2026-08-13). The
 * signup hook also seeds `integrationRules.system = { mode: 'autonomy' }`, but
 * that seed is the SECOND line of defense, not the first: the invariant
 * "`system.*` is structurally non-gateable" has to survive a future user toggle,
 * a missing default row, a botched migration, and a policy-editor bug, and all
 * four are data-layer failures that a check ahead of the read cannot see.
 *
 * Two consequences worth naming. Every caller is correct by default — including
 * a new `@alfred/http` write path that reaches this module and knows nothing
 * about the rule. And `system.*` still gates on the ADR-0069 `high`-tier floor,
 * which `toolRequiresApproval` ORs with this mode; `autonomy` here means "the
 * user's policy never gates a system tool", not "a system tool never stages".
 */
export async function resolvePolicyMode(userId: string, toolName: ToolName): Promise<PolicyMode> {
  const integration = integrationFromToolName(toolName);
  if (integration === "system") return "autonomy";

  const policy = await getResolvedPolicy(userId);
  const rule = pickRule(policy.integrationRules, integration);
  const override = rule?.toolOverrides?.[toolName];
  if (override) return override;
  if (rule?.mode) return rule.mode;
  return policy.defaultMode;
}

export async function resolveApprovalNotifyDelayMs(userId: string): Promise<number> {
  const policy = await getResolvedPolicy(userId);
  return policy.approvalNotifyDelayMs;
}

/** Drop the cached row for one user. Called locally by the subscriber and by tests. */
export function bustPolicyCache(userId: string): void {
  cache.delete(userId);
}

/** Drop the entire cache. Test-only — production code uses the per-user bust. */
export function clearPolicyCacheForTests(): void {
  cache.clear();
}

/**
 * Seed a resolved policy so `getResolvedPolicy` answers without a DB read.
 * Test-only. The dispatch gate's approval floor calls
 * `resolveApprovalNotifyDelayMs` the moment a call gates, so a DB-free test of
 * the floor needs the cache warm — it is the one policy read the gate cannot
 * short-circuit.
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
 * Publish a bust message so every server instance drops its cached row
 * for `userId`. Call this after every successful UPDATE to
 * `user_action_policies` (Phase 8 editor).
 *
 * Uses a single shared publisher connection across the process — PUBLISH
 * is non-blocking and doesn't conflict with itself the way SUBSCRIBE
 * commands do, so one connection is enough. Lazy-initialized so tests
 * and CLI scripts that never publish don't open a Redis socket. Tracked
 * via `createRedisConnection("command")` so `closeRedis()` at shutdown
 * drains it, and bounded by that kind so an unreachable Redis rejects
 * into the `catch` below instead of leaving this `await` pending.
 */
export async function publishPolicyBust(userId: string): Promise<void> {
  // Best-effort: don't surface a Redis blip as a user-facing failure on
  // the policy mutation itself. The trade-off is real — the in-process
  // policy cache has NO TTL, so a dropped bust leaves stale data on
  // every other server instance until the next successful bust for
  // that user or a process restart. For single-user Alfred this is
  // acceptable; for a multi-tenant fork, add a TTL (e.g. 60s) to the
  // cache entries as a safety net.
  try {
    await getPublisher().publish(bustChannel(userId), "1");
  } catch (err) {
    console.error("[action-policies] publishPolicyBust failed", {
      userId,
      error: toMessage(err),
    });
  }
}

let subscriber: IORedis | undefined;
let subscriberStarted = false;

/**
 * Start the per-process subscriber. Idempotent — safe to call from
 * multiple bootstrap paths. Uses PSUBSCRIBE on `policy-bust:u:*` so a
 * single subscription covers every user; the channel suffix is parsed
 * out and fed to `bustPolicyCache`. Started once at server boot in
 * `apps/server/src/runtime.ts`.
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
    console.error("[action-policies] policy-bust subscriber error", {
      error: toMessage(err),
    });
  });

  try {
    await conn.psubscribe(POLICY_BUST_PATTERN);
  } catch (err) {
    // Don't latch `subscriberStarted` on a failed boot — a transient
    // Redis outage would otherwise leave policy invalidation
    // permanently disabled until the process restarts. Close the
    // half-initialized connection and rethrow so the caller (server
    // bootstrap) can decide whether to crash or retry.
    try {
      await conn.quit();
    } catch {
      conn.disconnect();
    }
    throw err;
  }

  // Commit the started flag + retained reference only after the
  // subscription is live. Order matters: a second concurrent caller
  // mid-await above must see `subscriberStarted === false` and try
  // again rather than no-op into a non-started state.
  subscriber = conn;
  subscriberStarted = true;

  // A reconnect drops the pattern subscription, and the `"subscriber"` kind
  // sets `autoResubscribe: false` — ioredis's own re-subscribe carries no
  // `.catch`, so any rejection of it exits the process. Re-issuing is therefore
  // this module's job. Without it a single reconnect leaves every policy edit
  // stale on this instance until restart, and SILENTLY: nothing rejects, the
  // messages simply stop arriving.
  //
  // Registered only after the first subscription is live, so the initial
  // `ready` does not issue a second, redundant PSUBSCRIBE.
  conn.on("ready", () => {
    if (!subscriberStarted) return;
    conn.psubscribe(POLICY_BUST_PATTERN).catch((err: unknown) => {
      console.error("[action-policies] policy-bust re-subscribe after reconnect failed", {
        error: toMessage(err),
      });
    });
  });
}

/**
 * Stop the subscriber and drop the shared publisher reference. Idempotent —
 * called from the server's shutdown path before `closeRedis()` so the
 * symmetry with every other start/stop pair holds. `closeRedis()` will
 * still close the tracked connections; this just clears module state so
 * a subsequent restart in the same process (tests, long-running CLIs)
 * starts from a clean slate.
 */
export async function stopPolicyBustSubscriber(): Promise<void> {
  if (subscriberStarted) {
    subscriberStarted = false;
    if (subscriber) {
      try {
        await subscriber.punsubscribe(POLICY_BUST_PATTERN);
      } catch {
        // ignore — connection may already be closing
      }
      subscriber = undefined;
    }
  }
  // Drop the shared publisher ref too. `closeRedis()` (called next in
  // shutdown) closes the underlying socket; we just clear the cached
  // handle so any re-init after shutdown opens a fresh connection
  // instead of trying to use a closed one.
  publisher = undefined;
}

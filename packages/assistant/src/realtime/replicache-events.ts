/**
 * Replicache poke bus.
 *
 * A "poke" tells a connected client that its next pull will have new data.
 * Emitted by the push handler after a mutation commits; delivered to the
 * /api/replicache/events SSE stream which the Replicache client monitors.
 *
 * Channel scoping: pokes are published on per-user Redis channels
 * (`replicache-pokes:u:<userId>`). A replica only subscribes to channels
 * for users whose SSE connections it currently holds (refcounted).
 *
 * CONTRACT: every caller MUST fire pokes AFTER the transaction that produced
 * the syncable write has committed — pokes inside an uncommitted tx cause the
 * client to pull before the write is visible.
 */
import { EventEmitter } from "node:events";
import type IORedis from "ioredis";
import { createRedisConnection, isQueueEnabled, type BoundedRedis } from "@alfred/db/redis";
import { isRecord, toMessage } from "@alfred/contracts";

interface ReplicachePoke {
  userId: string;
  /** Empty string for user-scoped pokes with no specific entity context. */
  assetId: string;
}

type PokeListener = (payload: ReplicachePoke) => void;

function isReplicachePoke(value: unknown): value is ReplicachePoke {
  return isRecord(value) && typeof value.userId === "string" && typeof value.assetId === "string";
}

const eventFor = (userId: string) => `poke:${userId}`;

const CHANNEL_PREFIX = "replicache-pokes:u:";
const channelFor = (userId: string) => `${CHANNEL_PREFIX}${userId}`;
const userIdFromChannel = (channel: string): string | null =>
  channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let publisher: BoundedRedis | undefined;
let subscriber: IORedis | undefined;

/** Refcount of active SSE listeners per user on this replica. */
const userRefCounts = new Map<string, number>();
/**
 * Which users this replica actually holds a Redis subscription for, tracked
 * apart from the listener refcount.
 *
 * The two are NOT the same thing, and conflating them made a single failed
 * SUBSCRIBE permanently deaf: a rejected subscribe left the refcount at 1, so
 * no later listener ever passed the "first listener" test and re-issued it, and
 * ioredis will not re-issue it either — its auto-resubscribe reads the channel
 * list from `condition.subscriber`, which is populated only from a SUBSCRIBE
 * REPLY that never arrived — and on the `"subscriber"` kind ioredis's
 * auto-resubscribe is switched off outright. `subscribed` records replies,
 * `subscribing` keeps a second listener from issuing a duplicate while the first
 * is in flight, and `resubscribeAll` below rebuilds both after a reconnect.
 */
const subscribed = new Set<string>();
const subscribing = new Set<string>();

/**
 * Subscribe to `userId`'s channel unless this replica already holds it or is
 * already asking for it. Safe to call on every listener registration and on
 * every reconnect.
 */
function ensureSubscribed(userId: string): void {
  const conn = subscriber;
  if (!conn) return;
  if (subscribed.has(userId) || subscribing.has(userId)) return;
  subscribing.add(userId);
  conn.subscribe(channelFor(userId)).then(
    () => {
      subscribing.delete(userId);
      // The last listener may have gone while the subscribe was in flight; its
      // teardown could not unsubscribe a channel this replica did not yet hold.
      if ((userRefCounts.get(userId) ?? 0) > 0) subscribed.add(userId);
      else conn.unsubscribe(channelFor(userId)).catch(() => {});
    },
    (err: unknown) => {
      subscribing.delete(userId);
      console.warn("[replicache-events] subscribe failed for user", userId, toMessage(err));
    },
  );
}

/**
 * Re-subscribe every user this replica still has listeners for.
 *
 * A reconnect drops every server-side subscription, and the `"subscriber"` kind
 * sets `autoResubscribe: false`, so ioredis will NOT re-issue them — deliberately,
 * because the command it would issue is the one command on the connection that
 * no module catches, and an uncaught rejection exits the process. Re-issuing is
 * therefore this module's job, and `ready` is the only event that says the
 * connection can carry a subscription again.
 *
 * This is also the recovery path for a subscribe that REJECTED. A listener that
 * was already registered when its SUBSCRIBE failed is not re-subscribed by a
 * later listener arriving — there may never be one — so without this the listener
 * stays deaf for the life of its SSE stream, including after Redis comes back.
 *
 * Both sets are cleared first. `subscribed` because the server no longer holds
 * any of it; `subscribing` because a subscribe still in flight from the previous
 * socket would otherwise block the re-issue, and if it then rejects there is no
 * further `ready` to recover it. A duplicate SUBSCRIBE is harmless — Redis
 * ignores the second, and both settlements write into the same Set.
 */
function resubscribeAll(): void {
  subscribed.clear();
  subscribing.clear();
  for (const [userId, count] of userRefCounts) {
    if (count > 0) ensureSubscribed(userId);
  }
}

export async function initReplicachePokeBridge(): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    publisher = createRedisConnection("command");
    // `"subscriber"`, not `"command"`: ioredis's own re-subscribe after a
    // reconnect carries no `.catch`, so any rejection of it exits the server.
    // The kind removes that command rather than the ways it can fail, which is
    // why the `ready` handler below has to exist.
    subscriber = createRedisConnection("subscriber");

    subscriber.on("ready", resubscribeAll);

    subscriber.on("message", (channel: string, raw: string) => {
      const userId = userIdFromChannel(channel);
      if (userId === null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isReplicachePoke(parsed)) return;
        if (parsed.userId !== userId) return;
        emitter.emit(eventFor(userId), parsed);
      } catch {
        // malformed JSON — drop
      }
    });

    console.info("[replicache-events] Redis pub/sub bridge initialized");
  } catch (err) {
    console.warn("[replicache-events] Redis pub/sub bridge disabled:", toMessage(err));
    publisher = undefined;
    subscriber = undefined;
  }
}

export async function closeReplicachePokeBridge(): Promise<void> {
  if (subscriber) {
    // Only channels this replica actually holds: unsubscribing one it never
    // subscribed to is a wasted round trip on a connection that may be down.
    const channels = Array.from(subscribed).map(channelFor);
    if (channels.length > 0) {
      await subscriber.unsubscribe(...channels).catch(() => {});
    }
  }
  userRefCounts.clear();
  subscribed.clear();
  subscribing.clear();
  publisher = undefined;
  subscriber = undefined;
}

function publish(event: ReplicachePoke): void {
  const channel = channelFor(event.userId);
  // Lazy-init the Redis publisher so processes that didn't call
  // `initReplicachePokeBridge()` (smoke scripts, ad-hoc CLI work,
  // BullMQ workers in alternative entry points) still deliver pokes
  // across processes. The subscriber side stays gated on init —
  // only the SSE handler subscribes, and that runs from the server.
  if (!publisher && isQueueEnabled()) {
    try {
      publisher = createRedisConnection("command");
    } catch {
      publisher = undefined;
    }
  }
  if (publisher) {
    publisher.publish(channel, JSON.stringify(event)).catch(() => {
      emitter.emit(eventFor(event.userId), event);
    });
    return;
  }
  emitter.emit(eventFor(event.userId), event);
}

export function emitReplicachePokes(userIds: string[], assetId = ""): void {
  for (const userId of userIds) {
    publish({ userId, assetId });
  }
}

/**
 * Register an SSE listener for pokes addressed to `userId`. Returns an
 * unsubscribe function that MUST be called when the SSE connection closes.
 */
export function subscribeUserPokes(userId: string, listener: PokeListener): () => void {
  const eventName = eventFor(userId);
  emitter.on(eventName, listener);

  userRefCounts.set(userId, (userRefCounts.get(userId) ?? 0) + 1);
  // Called on EVERY registration, not only the first: it is idempotent, and a
  // later listener is the only thing that can recover a subscribe that failed.
  ensureSubscribed(userId);

  return () => {
    emitter.off(eventName, listener);
    const remaining = (userRefCounts.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      userRefCounts.delete(userId);
      if (subscribed.delete(userId) && subscriber) {
        subscriber.unsubscribe(channelFor(userId)).catch(() => {});
      }
    } else {
      userRefCounts.set(userId, remaining);
    }
  };
}

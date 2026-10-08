/**
 * Replicache poke bus: tells a client on `/api/replicache/events` to pull.
 * One Redis channel per user; a replica subscribes only for users it holds SSE streams for.
 * Poke only after the write's transaction commits, or the client pulls too early.
 */
import { EventEmitter } from "node:events";
import type IORedis from "ioredis";
import { createRedisConnection, isQueueEnabled, type BoundedRedis } from "@alfred/db/redis";
import { isRecord, toMessage } from "@alfred/contracts";

interface ReplicachePoke {
  userId: string;
  /** Empty for a user-wide poke. */
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

const userRefCounts = new Map<string, number>();

/**
 * Confirmed subscriptions, kept apart from the refcount: one failed SUBSCRIBE
 * must not make a user deaf for good. `subscribing` stops duplicate requests.
 */
const subscribed = new Set<string>();

const subscribing = new Set<string>();

/** Idempotent; safe on every listener registration and reconnect. */
function ensureSubscribed(userId: string): void {
  const conn = subscriber;

  if (!conn) return;

  if (subscribed.has(userId) || subscribing.has(userId)) return;
  subscribing.add(userId);
  conn.subscribe(channelFor(userId)).then(
    () => {
      subscribing.delete(userId);

      // The last listener may have left while the subscribe was in flight.
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
 * Runs on `ready`. The `"subscriber"` kind turns off ioredis auto-resubscribe,
 * because its uncaught rejection would exit the process. Also recovers a rejected subscribe.
 * Clear `subscribing` too, or a stale in-flight request blocks the re-issue.
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
    // `"subscriber"`: ioredis's own resubscribe has no `.catch`, so `ready` does it instead.
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
      } catch {}
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

  // Lazy init, so scripts and workers that skip `initReplicachePokeBridge()` still poke.
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

export function emitReplicachePokesOverRedis(userIds: string[], assetId = ""): void {
  for (const userId of userIds) {
    publish({ userId, assetId });
  }
}

/** Call the returned function when the SSE connection closes. */
export function subscribeUserPokes(userId: string, listener: PokeListener): () => void {
  const eventName = eventFor(userId);
  emitter.on(eventName, listener);

  userRefCounts.set(userId, (userRefCounts.get(userId) ?? 0) + 1);
  // On every registration, so a later listener can recover a failed subscribe.
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

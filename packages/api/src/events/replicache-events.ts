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
import { createRedisConnection, isQueueEnabled } from "../queue/connection";

export interface ReplicachePoke {
  userId: string;
  /** Empty string for user-scoped pokes with no specific entity context. */
  assetId: string;
}

type PokeListener = (payload: ReplicachePoke) => void;

function isReplicachePoke(value: unknown): value is ReplicachePoke {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { userId?: unknown; assetId?: unknown };
  return typeof v.userId === "string" && typeof v.assetId === "string";
}

const eventFor = (userId: string) => `poke:${userId}`;

const CHANNEL_PREFIX = "replicache-pokes:u:";
const channelFor = (userId: string) => `${CHANNEL_PREFIX}${userId}`;
const userIdFromChannel = (channel: string): string | null =>
  channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let publisher: IORedis | undefined;
let subscriber: IORedis | undefined;

/** Refcount of active SSE listeners per user on this replica. */
const userRefCounts = new Map<string, number>();

export async function initReplicachePokeBridge(): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    publisher = createRedisConnection();
    subscriber = createRedisConnection();

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
    console.warn(
      "[replicache-events] Redis pub/sub bridge disabled:",
      err instanceof Error ? err.message : String(err),
    );
    publisher = undefined;
    subscriber = undefined;
  }
}

export async function closeReplicachePokeBridge(): Promise<void> {
  if (subscriber) {
    const channels = Array.from(userRefCounts.keys()).map(channelFor);
    if (channels.length > 0) {
      await subscriber.unsubscribe(...channels).catch(() => {});
    }
  }
  userRefCounts.clear();
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
      publisher = createRedisConnection();
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

  const prev = userRefCounts.get(userId) ?? 0;
  userRefCounts.set(userId, prev + 1);

  if (prev === 0 && subscriber) {
    subscriber.subscribe(channelFor(userId)).catch((err) => {
      console.warn(
        "[replicache-events] subscribe failed for user",
        userId,
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  return () => {
    emitter.off(eventName, listener);
    const remaining = (userRefCounts.get(userId) ?? 1) - 1;
    if (remaining <= 0) {
      userRefCounts.delete(userId);
      if (subscriber) {
        subscriber.unsubscribe(channelFor(userId)).catch(() => {});
      }
    } else {
      userRefCounts.set(userId, remaining);
    }
  };
}

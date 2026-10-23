/**
 * The Redis subscription lifecycle for a bus with one channel per user.
 * A replica subscribes only for users that have a local listener, and unsubscribes after the last detach.
 * Each bus keeps its own connections, payload guard, and publish failure rules.
 */
import { EventEmitter } from "node:events";
import type IORedis from "ioredis";
import { logger } from "@alfred/logging";

interface UserChannelOptions<T> {
  /** For example `"replicache-pokes:u:"`. */
  channelPrefix: string;
  /** For example `"[replicache-events]"`. */
  logTag: string;
  /** Validates one parsed message for the user that owns its channel. */
  accept: (value: unknown, userId: string) => value is T;
}

interface UserChannelSubscriptions<T> {
  /** Adopts the subscriber connection: `ready` resubscribes every user, `message` delivers locally. */
  bind: (subscriber: IORedis) => void;
  /** The first listener for a user subscribes. Call the returned function to detach. */
  listen: (userId: string, listener: (payload: T) => void) => () => void;
  /** Delivers to local listeners only, with no Redis round trip. */
  deliverLocally: (userId: string, payload: T) => void;
  channelFor: (userId: string) => string;
  /** Unsubscribes confirmed channels and forgets the connection and every refcount. */
  close: () => Promise<void>;
}

export function createUserChannelSubscriptions<T>({
  channelPrefix,
  logTag,
  accept,
}: UserChannelOptions<T>): UserChannelSubscriptions<T> {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  let subscriber: IORedis | undefined;
  const userRefCounts = new Map<string, number>();

  /**
   * Confirmed subscriptions, kept apart from the refcount: one failed SUBSCRIBE
   * must not make a user deaf for good. `subscribing` stops duplicate requests.
   */
  const subscribed = new Set<string>();
  const subscribing = new Set<string>();

  const channelFor = (userId: string) => `${channelPrefix}${userId}`;

  const userIdFromChannel = (channel: string): string | null =>
    channel.startsWith(channelPrefix) ? channel.slice(channelPrefix.length) : null;

  /** Idempotent; safe on every listener registration and reconnect. */
  function ensureSubscribed(userId: string): void {
    // Keep this connection: a late reply must unsubscribe on the connection that subscribed.
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
        logger.warn({ err, userId }, `${logTag} subscribe failed for user`);
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

  function bind(conn: IORedis): void {
    subscriber = conn;
    conn.on("ready", resubscribeAll);

    conn.on("message", (channel: string, raw: string) => {
      const userId = userIdFromChannel(channel);

      if (userId === null) return;

      try {
        const parsed: unknown = JSON.parse(raw);

        if (!accept(parsed, userId)) return;
        emitter.emit(userId, parsed);
      } catch {
        // Drop the message: its payload is not JSON, or a local listener threw. This handler runs
        // inside ioredis's socket read, so a throw must not escape it and stall the bus for all users.
      }
    });
  }

  function listen(userId: string, listener: (payload: T) => void): () => void {
    emitter.on(userId, listener);

    userRefCounts.set(userId, (userRefCounts.get(userId) ?? 0) + 1);
    // On every registration, so a later listener can recover a failed subscribe.
    ensureSubscribed(userId);

    return () => {
      emitter.off(userId, listener);
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

  async function close(): Promise<void> {
    if (subscriber) {
      const channels = Array.from(subscribed).map(channelFor);

      if (channels.length > 0) {
        await subscriber.unsubscribe(...channels).catch(() => {});
      }
    }

    userRefCounts.clear();
    subscribed.clear();
    subscribing.clear();
    subscriber = undefined;
  }

  return {
    bind,
    listen,
    deliverLocally: (userId, payload) => {
      emitter.emit(userId, payload);
    },
    channelFor,
    close,
  };
}

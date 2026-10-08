/**
 * Redis fan-out of outbox frames to local SSE listeners, one channel per user.
 * Same subscribe and refcount rules as `replicache-events.ts`.
 */
import { EventEmitter } from "node:events";
import type IORedis from "ioredis";
import type { BoundedRedis } from "@alfred/db/redis";
import type { EventFrame } from "@alfred/contracts/events";
import { isKnownEventKind } from "@alfred/contracts/events";
import { isRecord, toMessage } from "@alfred/contracts";

type FrameListener = (frame: EventFrame) => void;

const CHANNEL_PREFIX = "user-events:u:";

const channelFor = (userId: string) => `${CHANNEL_PREFIX}${userId}`;

const userIdFromChannel = (channel: string): string | null =>
  channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;

const eventFor = (userId: string) => `frame:${userId}`;

const emitter = new EventEmitter();

emitter.setMaxListeners(0);

let publisher: BoundedRedis | undefined;

let subscriber: IORedis | undefined;

const userRefCounts = new Map<string, number>();

/** Confirmed subscriptions, kept apart from the refcount (see `replicache-events.ts`). */
const subscribed = new Set<string>();

const subscribing = new Set<string>();

function ensureSubscribed(userId: string): void {
  const conn = subscriber;

  if (!conn) return;

  if (subscribed.has(userId) || subscribing.has(userId)) return;
  subscribing.add(userId);
  conn.subscribe(channelFor(userId)).then(
    () => {
      subscribing.delete(userId);

      if ((userRefCounts.get(userId) ?? 0) > 0) subscribed.add(userId);
      else conn.unsubscribe(channelFor(userId)).catch(() => {});
    },
    (err: unknown) => {
      subscribing.delete(userId);
      console.warn("[user-events] subscribe failed for user", userId, toMessage(err));
    },
  );
}

/** Runs on `ready`: the `"subscriber"` kind turns off ioredis auto-resubscribe. */
function resubscribeAll(): void {
  subscribed.clear();
  subscribing.clear();

  for (const [userId, count] of userRefCounts) {
    if (count > 0) ensureSubscribed(userId);
  }
}

function isFrame(value: unknown): value is EventFrame {
  if (!isRecord(value)) return false;
  const v = value;

  return (
    typeof v.id === "number" &&
    Number.isFinite(v.id) &&
    typeof v.kind === "string" &&
    isKnownEventKind(v.kind) &&
    typeof v.createdAt === "string"
  );
}

export async function initUserEventsBus(): Promise<void> {
  if (publisher && subscriber) return;
  const { isQueueEnabled, createRedisConnection } = await import("@alfred/db/redis");

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

        if (!isFrame(parsed)) return;
        emitter.emit(eventFor(userId), parsed);
      } catch {}
    });

    console.info("[user-events] Redis pub/sub bus initialized");
  } catch (err) {
    console.warn("[user-events] Redis pub/sub bus disabled:", toMessage(err));
    publisher = undefined;
    subscriber = undefined;
  }
}

export async function closeUserEventsBus(): Promise<void> {
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

/** The outbox relay calls this before it marks the row published. */
export async function publishFrameToUser(userId: string, frame: EventFrame): Promise<void> {
  const body = JSON.stringify(frame);

  if (publisher) {
    await publisher.publish(channelFor(userId), body);

    return;
  }

  // No Redis: deliver to local listeners only.
  emitter.emit(eventFor(userId), frame);
}

export function subscribeUserEvents(userId: string, listener: FrameListener): () => void {
  const eventName = eventFor(userId);
  emitter.on(eventName, listener);

  userRefCounts.set(userId, (userRefCounts.get(userId) ?? 0) + 1);
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

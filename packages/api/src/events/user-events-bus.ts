/**
 * User-events Pub/Sub fan-out.
 *
 * Pairs with the outbox relay: the relay publishes onto Redis on
 * `user-events:u:<userId>`; this module subscribes (refcounted per user on
 * this replica) and delivers frames to local SSE listeners through an
 * EventEmitter so multiple browser tabs sharing a server replica share one
 * Redis channel.
 *
 * Mirrors the structure of `replicache-events.ts` deliberately — same
 * subscribe/publish/refcount discipline so future maintainers see one pattern.
 */
import { EventEmitter } from "node:events";
import type IORedis from "ioredis";
import type { EventFrame } from "./types";
import { isKnownEventKind } from "./types";
import { isRecord, toMessage } from "@alfred/contracts";

type FrameListener = (frame: EventFrame) => void;

const CHANNEL_PREFIX = "user-events:u:";
const channelFor = (userId: string) => `${CHANNEL_PREFIX}${userId}`;
const userIdFromChannel = (channel: string): string | null =>
  channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;
const eventFor = (userId: string) => `frame:${userId}`;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let publisher: IORedis | undefined;
let subscriber: IORedis | undefined;

const userRefCounts = new Map<string, number>();

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
  const { isQueueEnabled, createRedisConnection } = await import("../queue/connection");
  if (!isQueueEnabled()) return;

  try {
    publisher = createRedisConnection();
    subscriber = createRedisConnection();

    subscriber.on("message", (channel: string, raw: string) => {
      const userId = userIdFromChannel(channel);
      if (userId === null) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isFrame(parsed)) return;
        emitter.emit(eventFor(userId), parsed);
      } catch {
        // malformed JSON — drop
      }
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
    const channels = Array.from(userRefCounts.keys()).map(channelFor);
    if (channels.length > 0) {
      await subscriber.unsubscribe(...channels).catch(() => {});
    }
  }
  userRefCounts.clear();
  publisher = undefined;
  subscriber = undefined;
}

/** Called by the outbox relay after marking a row published. */
export async function publishFrameToUser(userId: string, frame: EventFrame): Promise<void> {
  const body = JSON.stringify(frame);
  if (publisher) {
    await publisher.publish(channelFor(userId), body);
    return;
  }
  // Single-replica fallback — still deliver to local SSE listeners.
  emitter.emit(eventFor(userId), frame);
}

export function subscribeUserEvents(userId: string, listener: FrameListener): () => void {
  const eventName = eventFor(userId);
  emitter.on(eventName, listener);

  const prev = userRefCounts.get(userId) ?? 0;
  userRefCounts.set(userId, prev + 1);

  if (prev === 0 && subscriber) {
    subscriber.subscribe(channelFor(userId)).catch((err) => {
      console.warn("[user-events] subscribe failed for user", userId, toMessage(err));
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

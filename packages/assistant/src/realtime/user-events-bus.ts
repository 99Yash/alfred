/**
 * Redis fan-out of outbox frames to local SSE listeners, one channel per user.
 * `user-channel-subscriptions.ts` owns the subscribe and refcount rules, shared with `replicache-events.ts`.
 */
import type { BoundedRedis } from "@alfred/db/redis";
import type { EventFrame } from "@alfred/contracts/events";
import { isKnownEventKind } from "@alfred/contracts/events";
import { isRecord } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { createUserChannelSubscriptions } from "./user-channel-subscriptions";

type FrameListener = (frame: EventFrame) => void;

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

const frames = createUserChannelSubscriptions<EventFrame>({
  channelPrefix: "user-events:u:",
  logTag: "[user-events]",
  accept: isFrame,
});

let publisher: BoundedRedis | undefined;

export async function initUserEventsBus(): Promise<void> {
  // `publisher` alone marks a bound bus: the subscriber binds in the same synchronous `try`.
  if (publisher) return;
  const { isQueueEnabled, createRedisConnection } = await import("@alfred/db/redis");

  if (!isQueueEnabled()) return;

  try {
    publisher = createRedisConnection("command");
    // `"subscriber"`: ioredis's own resubscribe has no `.catch`, so `ready` does it instead.
    frames.bind(createRedisConnection("subscriber"));

    logger.info("[user-events] Redis pub/sub bus initialized");
  } catch (err) {
    logger.warn({ err }, "[user-events] Redis pub/sub bus disabled");
    publisher = undefined;
  }
}

export async function closeUserEventsBus(): Promise<void> {
  await frames.close();
  publisher = undefined;
}

/** The outbox relay calls this before it marks the row published. */
export async function publishFrameToUser(userId: string, frame: EventFrame): Promise<void> {
  const body = JSON.stringify(frame);

  if (publisher) {
    await publisher.publish(frames.channelFor(userId), body);

    return;
  }

  // No Redis: deliver to local listeners only.
  frames.deliverLocally(userId, frame);
}

export function subscribeUserEvents(userId: string, listener: FrameListener): () => void {
  return frames.listen(userId, listener);
}

/**
 * Replicache poke bus: tells a client on `/api/replicache/events` to pull.
 * One Redis channel per user; a replica subscribes only for users it holds SSE streams for.
 * Poke only after the write's transaction commits, or the client pulls too early.
 */
import { createRedisConnection, isQueueEnabled, type BoundedRedis } from "@alfred/db/redis";
import { isRecord } from "@alfred/contracts";
import { logger } from "@alfred/logging";
import { createUserChannelSubscriptions } from "./user-channel-subscriptions";

interface ReplicachePoke {
  userId: string;
  /** Empty for a user-wide poke. */
  assetId: string;
}

type PokeListener = (payload: ReplicachePoke) => void;

function isReplicachePoke(value: unknown): value is ReplicachePoke {
  return isRecord(value) && typeof value.userId === "string" && typeof value.assetId === "string";
}

const pokes = createUserChannelSubscriptions<ReplicachePoke>({
  channelPrefix: "replicache-pokes:u:",
  logTag: "[replicache-events]",
  accept: (value, userId): value is ReplicachePoke =>
    isReplicachePoke(value) && value.userId === userId,
});

let publisher: BoundedRedis | undefined;

export async function initReplicachePokeBridge(): Promise<void> {
  if (!isQueueEnabled()) return;

  try {
    publisher = createRedisConnection("command");
    // `"subscriber"`: ioredis's own resubscribe has no `.catch`, so `ready` does it instead.
    pokes.bind(createRedisConnection("subscriber"));

    logger.info("[replicache-events] Redis pub/sub bridge initialized");
  } catch (err) {
    logger.warn({ err }, "[replicache-events] Redis pub/sub bridge disabled");
    publisher = undefined;
  }
}

export async function closeReplicachePokeBridge(): Promise<void> {
  await pokes.close();
  publisher = undefined;
}

function publish(event: ReplicachePoke): void {
  const channel = pokes.channelFor(event.userId);

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
      pokes.deliverLocally(event.userId, event);
    });

    return;
  }

  pokes.deliverLocally(event.userId, event);
}

export function emitReplicachePokesOverRedis(userIds: string[], assetId = ""): void {
  for (const userId of userIds) {
    publish({ userId, assetId });
  }
}

/** Call the returned function when the SSE connection closes. */
export function subscribeUserPokes(userId: string, listener: PokeListener): () => void {
  return pokes.listen(userId, listener);
}

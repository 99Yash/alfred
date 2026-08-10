/**
 * Realtime substrate: the runtime half of realtime delivery.
 *
 * This module owns the machinery that carries a domain event from the outbox to a
 * connected client — the Redis pub/sub user-event bus, the Postgres LISTEN/NOTIFY
 * outbox relay, the outbox retention reaper, the Replicache poke bridge, and the
 * cursor-paged read of `events_outbox` that a reconnecting client replays from.
 * Protocol framing (`Last-Event-ID`, `event:`/`data:` lines, heartbeats) is the
 * transport half and lives in `packages/http/src/realtime/`, not here.
 *
 * Importing this barrel evaluates every file in the module, so the module holds one
 * property that must survive any edit: **no module-scope evaluation reads the
 * environment, opens a Postgres pool or a Redis connection, or arms a timer.** Every
 * connection and every timer is created inside one of the four lifecycle functions.
 * `packages/assistant/test/realtime/barrel-load.test.ts` pins it.
 *
 * The relay, the reaper and the `PeriodicTask` primitive stay off this barrel on
 * purpose: they are internals of the delivery loop, and only its own tests reach them.
 */
export { closeEventBridge, initEventBridge } from "./bridge";
export { getEventsSince, getReplayHighWatermark } from "./replay";
export {
  closeReplicachePokeBridge,
  emitReplicachePokes,
  initReplicachePokeBridge,
  subscribeUserPokes,
} from "./replicache-events";
export { subscribeUserEvents } from "./user-events-bus";

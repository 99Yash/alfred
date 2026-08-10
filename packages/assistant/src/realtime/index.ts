/**
 * Realtime substrate: the runtime half of realtime delivery.
 *
 * This module owns the machinery that carries a domain event from the outbox to a
 * connected client — the Redis pub/sub user-event bus, the Postgres LISTEN/NOTIFY
 * outbox relay, the outbox retention reaper, the Replicache poke bridge, and the
 * cursor-paged read of `events_outbox` that a reconnecting client replays from.
 * Protocol framing (`Last-Event-ID`, `event:`/`data:` lines, heartbeats) is the
 * transport half. It still sits in `packages/api/src/modules/events/index.ts` today
 * and moves to `packages/http/src/realtime/`; either way it does not belong here.
 *
 * `emitReplicachePokesOverRedis` is the concrete publisher. Producers should not call
 * it — they call the `emitReplicachePokes` port on `@alfred/assistant/triggers`, which
 * is a no-op until a process registers this concrete behind it. The two names differ
 * so that an editor auto-import cannot silently turn a documented no-op into a live
 * Redis publish.
 *
 * Importing this barrel evaluates every file in the module, so the module holds one
 * property that must survive any edit: **no module-scope evaluation reads the
 * environment, opens a Postgres pool or a Redis connection, or arms a timer.** Every
 * connection and every timer is created inside one of the four lifecycle functions.
 * `packages/assistant/test/realtime/barrel-load.test.ts` pins three of the four clauses:
 * the env read (the import throws without `DATABASE_URL` / `REDIS_URL`), an armed timer
 * and an opened socket (both visible in `process.getActiveResourcesInfo()`). A
 * `new pg.Pool()` that is constructed but never connected opens nothing, so that one
 * shape is prose only — keep pool construction inside the lifecycle functions anyway.
 *
 * The relay, the reaper and the `PeriodicTask` primitive stay off this barrel on
 * purpose: they are internals of the delivery loop, and only its own tests reach them.
 */
export { closeEventBridge, initEventBridge } from "./bridge";
export { getEventsSince, getReplayHighWatermark } from "./replay";
export {
  closeReplicachePokeBridge,
  emitReplicachePokes as emitReplicachePokesOverRedis,
  initReplicachePokeBridge,
  subscribeUserPokes,
} from "./replicache-events";
export { subscribeUserEvents } from "./user-events-bus";

/**
 * Realtime substrate: the runtime half of realtime delivery.
 *
 * This module owns the machinery that carries a domain event from the outbox to a
 * connected client — the Redis pub/sub user-event bus, the Postgres LISTEN/NOTIFY
 * outbox relay, the outbox retention reaper, the Replicache poke bridge, and the
 * cursor-paged read of `events_outbox` that a reconnecting client replays from.
 * Protocol framing (`Last-Event-ID`, `event:`/`data:` lines, heartbeats) is the
 * transport half. It lives in `packages/http/src/realtime/`, which imports this
 * barrel; it does not belong here.
 *
 * `emitReplicachePokesOverRedis` is the concrete publisher. Producers should not call
 * it — they call the `emitReplicachePokes` port on `@alfred/assistant/triggers`, which
 * is a no-op until a process registers this concrete behind it. The two names differ
 * so that an editor auto-import cannot silently turn a documented no-op into a live
 * Redis publish.
 *
 * Importing this barrel evaluates every file in the module, so the module holds one
 * property that must survive any edit: **no module-scope evaluation reads the
 * environment, opens a Postgres pool or a Redis connection, or arms a timer.**
 * That property is not pinned here and is not specific to this barrel: it is pinned for
 * every subpath `@alfred/assistant` advertises, by `packages/assistant/test/barrel-load.test.ts`.
 * Read that file's docstring for the detectors and — more importantly — for the shapes
 * they cannot see. It is the single statement of both; this header does not repeat it,
 * because a limit restated in two places narrows in one and stays wide in the other.
 * One realtime-specific instruction the probe cannot give: a `new pg.Pool()` that is
 * constructed but never connected arms no timer and opens no handle, so it is invisible
 * to every detector there — keep pool construction inside the lifecycle functions anyway.
 *
 * At run time the module holds a second property, and it is the predicate the guards
 * enforce rather than a claim about who calls what. Every timer this module arms, and
 * every Postgres client or Redis connection it builds, is reached one of three ways.
 * Most sit on the stack of one of the four lifecycle functions this barrel exports
 * (`initEventBridge` / `closeEventBridge`, `initReplicachePokeBridge` /
 * `closeReplicachePokeBridge`): the relay and reaper intervals, the relay's pool and its
 * first `pg.Client`, the user-events bus publisher and subscriber, the poke bridge's
 * publisher and subscriber, and the drain poll inside `PeriodicTask.stop`. Two are not —
 * the relay's `LISTEN` reconnect path, where the `listenClient.on("end")` handler arms a
 * ref'd `RECONNECT_DELAY_MS` `setTimeout` and `startListener` then builds a fresh
 * `pg.Client`, with no lifecycle function anywhere on the stack. `relay.stopped`, read at
 * both of those steps, is the whole mechanism, and `stopOutboxRelay` awaits
 * `relay.stop()` before it ends the client, so a shutdown builds no further one. The
 * third is the poke *publisher* again: `publish` re-creates it lazily on any
 * `emitReplicachePokesOverRedis` call, whether or not a bridge was ever initialised —
 * deliberately, so a worker or a smoke script still delivers pokes across processes.
 * What that buys is bounded. Once `closeEventBridge()` resolves, this module arms no
 * timer and builds no Postgres client; but a reconnect timer armed just before the stop
 * stays pending and holds the event loop open until it fires, and a later emit re-creates
 * the publisher. `passInFlight` in `outbox-reaper.ts` is no part of this — it keeps two
 * retention passes from overlapping and says nothing about lifetime.
 *
 * The relay, the reaper and the `PeriodicTask` primitive stay off this barrel on
 * purpose: they are internals of the delivery loop, and only its own tests reach them.
 */
export { closeEventBridge, initEventBridge } from "./bridge";
export { getEventsSince, getReplayHighWatermark } from "./replay";
export {
  closeReplicachePokeBridge,
  emitReplicachePokesOverRedis,
  initReplicachePokeBridge,
  subscribeUserPokes,
} from "./replicache-events";
export {
  registerReplicachePokeAdapter,
  unregisterReplicachePokeAdapter,
} from "./replicache-poke-adapter";
export { subscribeUserEvents } from "./user-events-bus";

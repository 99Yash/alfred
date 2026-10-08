/**
 * Realtime runtime: outbox relay and reaper, Redis user-event bus, Replicache
 * poke bridge, and outbox replay. SSE framing lives in `packages/http/src/realtime/`.
 *
 * Producers call the `emitReplicachePokes` port on `@alfred/assistant/triggers`,
 * not `emitReplicachePokesOverRedis`. The names differ so auto-import cannot pick the live one.
 *
 * No module-scope code may read env, open a pool or connection, or arm a timer
 * (`test/barrel-load.test.ts`). An unconnected `new pg.Pool()` escapes that probe,
 * so keep pool construction inside the lifecycle functions.
 * Outside those functions, only the relay's `LISTEN` reconnect and the lazy poke
 * publisher create connections; `relay.stopped` gates the reconnect.
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

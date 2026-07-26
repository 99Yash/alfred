import { z } from "zod";

/**
 * Connection-pool sizing for the shared `pg.Pool` (#437) — **one fact, one
 * place**.
 *
 * Agent-worker concurrency and the pool ceiling are not independent knobs: every
 * concurrent agent step draws from the same pool (a triage classify step alone
 * opens several reads — thread context, sender prior, sender kind, existing
 * triage row), and so does every other worker and every HTTP handler in the
 * process. Oversubscribe the pool and it queues *silently*: the BullMQ queue
 * just moves into `pg.Pool` as waiting clients, latency looks exactly like a
 * slow model, and HTTP handlers starve behind background work.
 *
 * That coupling used to be stated in five docstrings and enforced nowhere, with
 * the shipped defaults (concurrency 8 / pool 10) being precisely the pair the
 * deploy note warned against. So the pool ceiling is now *derived* from the one
 * knob a deploy actually tunes — `AGENT_WORKER_CONCURRENCY` — and `DB_POOL_MAX`
 * survives only as an explicit override for a deploy that knows better.
 */

/**
 * Floor for the pool, and the number of connections {@link import("@alfred/db").warmPool}
 * opens at boot. A derived or overridden max below this would leave `warmPool`
 * unable to ever resolve its `Promise.all` and the idle-reaper's above-min check
 * permanently false, so it is also the schema's minimum.
 */
export const POOL_MIN = 4;

/**
 * Connections one concurrent agent step can hold at once. Steps read
 * sequentially through Drizzle (one client checked out at a time) but overlap
 * with their own fire-and-forget metering write, so budget two rather than one.
 */
const CONNECTIONS_PER_STEP = 2;

/**
 * Connections reserved for everything that is not the agent worker: the other
 * nine workers, the Replicache push/pull handlers, and the pool heartbeat.
 * These are short reads, so a small fixed reserve is enough — the point is that
 * background work can never consume the whole pool.
 */
const NON_AGENT_HEADROOM = 4;

/** Default max concurrent agent runs per server process. */
export const AGENT_WORKER_CONCURRENCY_DEFAULT = 8;

/**
 * The one knob. Shared by the server env (which hands it to the agent worker)
 * and the DB-only env (which sizes the pool from it), so the default can't drift
 * between the two schemas the way it drifted between the env and the worker's
 * own `?? 4` fallback.
 */
export const agentWorkerConcurrencySchema = z.coerce
  .number()
  .int()
  .positive()
  .default(AGENT_WORKER_CONCURRENCY_DEFAULT);

/**
 * Pool ceiling for a given agent-worker concurrency. At the default 8 this is
 * 20 — the value the #437 deploy note asked operators to remember to set by
 * hand, now unforgettable because raising concurrency is the only way to move
 * it.
 */
export function derivePoolMax(agentWorkerConcurrency: number): number {
  return Math.max(POOL_MIN, agentWorkerConcurrency * CONNECTIONS_PER_STEP + NON_AGENT_HEADROOM);
}

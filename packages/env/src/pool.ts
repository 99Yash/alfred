import { z } from "zod";

/**
 * `pg.Pool` size derives from agent concurrency, since every agent step uses the pool.
 * An undersized pool queues silently and looks like a slow model.
 */

/**
 * Pool minimum, and the connections {@link import("@alfred/db").warmPool} opens at boot.
 * A max below it would make `warmPool` hang, so it is also the schema minimum.
 */
export const POOL_MIN = 4;

/** One step's read can overlap its own background metering write. */
const CONNECTIONS_PER_STEP = 2;

/** Reserve for other workers and HTTP handlers, so agent work never takes the whole pool. */
const NON_AGENT_HEADROOM = 4;

export const AGENT_WORKER_CONCURRENCY_DEFAULT = 8;

/** Shared by the server env and the database env so the default has one home. */
export const agentWorkerConcurrencySchema = z.coerce
  .number()
  .int()
  .positive()
  .default(AGENT_WORKER_CONCURRENCY_DEFAULT);

export function derivePoolMax(agentWorkerConcurrency: number): number {
  return Math.max(POOL_MIN, agentWorkerConcurrency * CONNECTIONS_PER_STEP + NON_AGENT_HEADROOM);
}

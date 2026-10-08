/**
 * Child process for `redis-subscriber-reconnect.test.ts`. A separate process because
 * `node:test` fails any test whose process sees an unhandled rejection, even with a listener.
 * Exits 1 on an unhandled rejection, like `apps/server/src/index.ts`.
 *
 * Usage: `tsx subscriber-reconnect-child.ts <kind> <redis-url>`.
 * Prints `READY` on each `ready` (a second one proves a reconnect) and `SUBSCRIBED` once.
 */
import { applyServerEnv } from "./server-env";

import type { RedisConnectionKind } from "../../src/redis";

/** Covers reconnect, a 2s `CLIENT SETINFO` timeout, then a 2s SUBSCRIBE timeout. */
const LIVE_WINDOW_MS = 8_000;

const KINDS: readonly RedisConnectionKind[] = ["queue", "command", "subscriber", "fail-fast"];

function parseKind(value: string | undefined): RedisConnectionKind {
  const kind = KINDS.find((candidate) => candidate === value);

  if (!kind) throw new Error(`unknown connection kind: ${String(value)}`);

  return kind;
}

// Mirrors apps/server/src/index.ts.
process.on("unhandledRejection", (reason) => {
  console.error(`UNHANDLED ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});

const kind = parseKind(process.argv[2]);

const redisUrl = process.argv[3];

if (redisUrl === undefined) throw new Error("expected a Redis URL as the second argument");

applyServerEnv(redisUrl);

const { createRedisConnection } = await import("../../src/redis");

// A non-literal kind picks the wide overload, so subscribe stays available.
const conn = createRedisConnection(kind);

// ioredis throws on an unhandled `error` event, which would exit 1 for the wrong reason.
conn.on("error", () => {});

conn.on("ready", () => console.log("READY"));

await conn.subscribe("subscriber-reconnect-probe");

console.log("SUBSCRIBED");

// No `disconnect()`: a manual close rejects queued commands for every kind and would muddy the result.
setTimeout(() => process.exit(0), LIVE_WINDOW_MS);

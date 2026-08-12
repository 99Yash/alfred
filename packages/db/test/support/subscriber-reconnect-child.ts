/**
 * The child half of `redis-subscriber-reconnect.test.ts`.
 *
 * It runs in its own process on purpose. One of the defects under test is an
 * UNHANDLED REJECTION — ioredis re-issues a subscription after a reconnect and
 * does not catch the result — and `node:test` fails any test in whose process
 * one occurs, even when the test itself installed a listener. So the only way to
 * assert "this profile does NOT kill the process" and, in the same harness,
 * "this other profile DOES" is to make the process boundary the assertion: this
 * file exits 1 on an unhandled rejection and 0 otherwise, exactly as
 * `apps/server/src/index.ts` does.
 *
 * Usage: `tsx subscriber-reconnect-child.ts <kind> <redis-url>`. It prints one
 * line per event the parent needs to see:
 *
 * - `READY` every time the connection reaches `ready`. The parent counts these.
 *   A second one is what PROVES a reconnect happened, and the previous version
 *   of this harness asserted nothing of the sort — its subject exited 0 by never
 *   reconnecting at all.
 * - `SUBSCRIBED` once, after the first subscription is live.
 *
 * It then stays alive for `LIVE_WINDOW_MS` while the parent takes Redis away,
 * and never exits on its own before that window.
 */
import { applyServerEnv } from "./server-env";

import type { RedisConnectionKind } from "../../src/redis";

/**
 * Long enough for the whole failure sequence the parent provokes: reconnect,
 * then the `CLIENT SETINFO` handshake timing out at `"command"`'s 2s bound,
 * then the re-issued SUBSCRIBE timing out 2s after that.
 */
const LIVE_WINDOW_MS = 8_000;

const KINDS: readonly RedisConnectionKind[] = ["queue", "command", "subscriber", "fail-fast"];

function parseKind(value: string | undefined): RedisConnectionKind {
  const kind = KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`unknown connection kind: ${String(value)}`);
  return kind;
}

// Mirrors apps/server/src/index.ts. This is the production consequence the
// parent measures, not a test convention.
process.on("unhandledRejection", (reason) => {
  console.error(`UNHANDLED ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});

const kind = parseKind(process.argv[2]);
const redisUrl = process.argv[3];
if (redisUrl === undefined) throw new Error("expected a Redis URL as the second argument");

applyServerEnv(redisUrl);
const { createRedisConnection } = await import("../../src/redis");

// The kind is a VALUE here, so this resolves to the widening overload and the
// handle keeps its subscribe verbs. A production call site passes a literal and
// gets `BoundedRedis` for the bounded kinds — see
// `test/type/redis-kind-surface.type-test.ts`.
const conn = createRedisConnection(kind);
// Every refused or torn-down attempt emits one; ioredis throws on an unhandled
// `error` event, which would exit 1 for a reason the parent is not testing.
conn.on("error", () => {});
conn.on("ready", () => console.log("READY"));

await conn.subscribe("subscriber-reconnect-probe");
console.log("SUBSCRIBED");

// No `disconnect()` first: a manual close flushes the in-flight queue with
// "Connection is closed." REGARDLESS of the profile, so tearing down here would
// mix a shutdown-path rejection into a measurement about reconnects.
setTimeout(() => process.exit(0), LIVE_WINDOW_MS);

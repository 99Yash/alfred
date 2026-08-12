/**
 * Compile-only fixture: a bounded connection must not be able to subscribe.
 *
 * Holding a SUBSCRIBE on a connection whose profile carries a `commandTimeout`
 * and ioredis's auto-resubscribe ends in `process.exit(1)` — ioredis re-issues
 * the subscription after a reconnect with no `.catch`, so any rejection of that
 * command is unhandled. `packages/db/src/redis.ts` documents the two routes to
 * that rejection.
 *
 * Naming alone did not stop it. All three subscriber handles in this repo were
 * written against the `"command"` kind first, by an author holding the whole
 * design, and `pnpm check`, `pnpm check-types` and two mutation probes passed
 * over them; the factory handed back the same `IORedis` for every kind, so
 * `.subscribe()` sat in autocomplete on a bounded handle. Returning
 * `BoundedRedis` from the bounded arms turns that into TS2339.
 *
 * The fixture fails CLOSED. If a future edit gives the bounded arms the subscribe
 * verbs back — by widening the return type, by adding an index signature, or by
 * deleting the overloads — the directives below go UNUSED and `check-types` goes
 * red, so a green run is evidence the gate is real rather than an assumption
 * that it is. The positive lines are what keeps the negatives honest: they prove
 * the type carries the ordinary command surface and that `"subscriber"` really
 * does keep the verbs.
 */
import { createRedisConnection } from "../../src/redis";

const command = createRedisConnection("command");
const failFast = createRedisConnection("fail-fast");
const subscriber = createRedisConnection("subscriber");
const queue = createRedisConnection("queue");

// The rule the fourth kind exists to carry, now checked rather than named.
// @ts-expect-error a "command" handle must not hold subscriptions
void command.subscribe;
// @ts-expect-error a "command" handle must not hold pattern subscriptions
void command.psubscribe;
// @ts-expect-error a "command" handle must not hold shard subscriptions
void command.ssubscribe;
// @ts-expect-error a "fail-fast" handle must not hold subscriptions
void failFast.subscribe;
// @ts-expect-error a "fail-fast" handle must not hold pattern subscriptions
void failFast.psubscribe;
// @ts-expect-error a "fail-fast" handle must not hold shard subscriptions
void failFast.ssubscribe;

// The two kinds that MAY subscribe still can, and the bounded kinds keep every
// ordinary command — an `Omit` that took too much would show up here.
void subscriber.subscribe;
void subscriber.psubscribe;
void queue.subscribe;
void command.publish;
void command.get;
void command.quit;
void failFast.set;

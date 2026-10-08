/**
 * Compile-only: a bounded connection must not subscribe. A subscription on a
 * `commandTimeout` connection can crash the process after a reconnect (see `src/redis.ts`).
 * If the bounded kinds get subscribe back, the `@ts-expect-error` lines go unused and fail.
 * The positive lines prove the ordinary commands and `"subscriber"` verbs remain.
 */
import { createRedisConnection } from "../../src/redis";

const command = createRedisConnection("command");

const failFast = createRedisConnection("fail-fast");

const subscriber = createRedisConnection("subscriber");

const queue = createRedisConnection("queue");

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

// An `Omit` that took too much would fail here.
void subscriber.subscribe;

void subscriber.psubscribe;

void queue.subscribe;

void command.publish;

void command.get;

void command.quit;

void failFast.set;

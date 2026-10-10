import { APICallError } from "@ai-sdk/provider";
import { toMessage } from "@alfred/contracts";
import { createRedisConnection, isQueueEnabled, reserveRateSlot } from "@alfred/db/redis";
import type { BoundedRedis } from "@alfred/db/redis";

/**
 * Client-side pacing for the Cloudflare AI Gateway. It sits in `fetch`, so it covers every caller.
 *
 * The edge sends two different 429s; only the body tells them apart:
 * - `internalCode 2003` "Rate limited": the gateway's own `rate_limiting_*` rule, our setting.
 * - `internalCode 2018` "Wholesale Rate limited": the Unified Billing budget, one per gateway,
 *   shared across all providers. Cloudflare documents 200/min; measured, it is a burst of
 *   about 15 to 25 that refills at single digits per minute.
 * The edge also sends `internalCode 2021` "Insufficient wholesale credits" as a 402: the Unified
 * Billing credit pool is empty for every provider, so `withFallback` does not switch on it.
 *
 * Pacing spreads Alfred's fan-out over that budget. It cannot make a drained bucket serve.
 * Under `maxWaitMs` the caller sleeps, then sends. Over it, the caller gets a retryable 429
 * that never reaches the wire, and retry, fallback, and the chat capacity ladder take over.
 * The wait counts against the SDK's `totalMs` only, so the cap must sit under the tightest caller.
 */

/**
 * Target rate for the whole gateway, under the documented 200/min. The margin covers scripts,
 * other replicas, and clock drift. Do not match it to a gateway `rate_limiting_limit`.
 */
const DEFAULT_REQUESTS_PER_MINUTE = 180;

/**
 * Requests that start with no delay after idle (`burst + 1`). Small on purpose:
 * a sequential agent loop never waits at 180/min, so this only covers a parallel fan-out.
 */
const DEFAULT_BURST = 2;

/**
 * Longest wait before the pacer refuses with a retryable 429. Sleeping past it would spend
 * the caller's deadline to buy a near-certain 429. Triage allows 30s in total
 * (`TRIAGE_REQUEST_TIMEOUT_MS`), so 20s leaves room for the call and its fallback.
 */
const DEFAULT_MAX_WAIT_MS = 20_000;

/** After a failed reservation, skip Redis this long, so a dead Redis costs one slow call per window. */
const REDIS_SUSPEND_MS = 30_000;

export interface GatewayThrottleConfig {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly requestsPerMinute?: number;
  readonly burst?: number;
  /** Must sit under the tightest caller's total timeout, because the wait counts against it. */
  readonly maxWaitMs?: number;
}

/**
 * Keyed by gateway, never by provider: all providers share one budget, and a provider
 * segment would multiply the rate. The rate is in the key so two pods at different
 * `CLOUDFLARE_AI_GATEWAY_RPM` values do not share one clock.
 */
function bucketKey(config: GatewayThrottleConfig, perMinute: number, burst: number): string {
  return `aigw:slot:${config.accountId}:${config.gatewayId}:${perMinute}:${burst}`;
}

/**
 * In-process GCRA, same math as the Lua script in `@alfred/db`. It paces alone without Redis,
 * and is the floor when Redis is unreachable.
 * `observeHonored()` pulls the local clock up to a later Redis answer, so a later outage
 * does not pace against a stale clock.
 * Past `maxWaitMs`, `take()` does not advance: a refused call takes no slot,
 * so the mark cannot run away.
 */
interface LocalPacer {
  take: (maxWaitMs?: number) => number;
  observeHonored: (localWait: number, honoredWait: number) => void;
}

function createLocalPacer(intervalMs: number, burst: number): LocalPacer {
  let theoreticalArrival = 0;

  return {
    take: (maxWaitMs) => {
      const now = Date.now();
      const tat = Math.max(theoreticalArrival, now);
      const wait = Math.max(0, tat - burst * intervalMs - now);

      if (maxWaitMs !== undefined && wait > maxWaitMs) return wait;

      theoreticalArrival = tat + intervalMs;

      return wait;
    },
    observeHonored: (localWait, honoredWait) => {
      // On an idle bucket this formula would push the mark a full burst window ahead.
      if (honoredWait > localWait) {
        theoreticalArrival = Math.max(
          theoreticalArrival,
          Date.now() + honoredWait + burst * intervalMs + intervalMs,
        );
      }
    },
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);

      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait for a slot, or reject with a retryable 429 past the cap. `url` only names the request. */
type SlotWaiter = (signal: AbortSignal | undefined, url: string) => Promise<void>;

/**
 * A 429 that never went to the wire. An `APICallError`, so `isCapacityError` treats it like a real one.
 * The message must avoid the words `isQuotaOrBillingError` matches, or the ladder gives up
 * and chat hides Retry.
 */
function overCapRefusal(waitMs: number, maxWaitMs: number, url: string): APICallError {
  return new APICallError({
    message:
      `[ai-gateway] gateway budget backed up ${waitMs}ms, past the ${maxWaitMs}ms cap ` +
      `this caller may wait; refusing without sending`,
    url,
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  });
}

/**
 * One waiter per budget per process. `activeGateway()` builds a new `Gateway` for every call,
 * but a pacer must remember earlier requests, so the state lives here.
 */
const waiters = new Map<string, SlotWaiter>();

/** Make every request wait for a slot. Pass the provider's own fetch wrapper as `inner`. */
export function throttledGatewayFetch(
  config: GatewayThrottleConfig,
  inner: typeof globalThis.fetch = fetch,
): typeof globalThis.fetch {
  const waitForSlot = sharedWaiter(config);

  return async (input, init) => {
    await waitForSlot(init?.signal ?? undefined, requestUrl(input));

    return inner(input, init);
  };
}

/** Typed off `fetch`, because this package builds without the DOM lib. */
function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") return input;

  return input instanceof URL ? input.toString() : input.url;
}

function sharedWaiter(config: GatewayThrottleConfig): SlotWaiter {
  const perMinute = config.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const burst = config.burst ?? DEFAULT_BURST;
  const maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const key = bucketKey(config, perMinute, burst);
  const memoKey = `${key}:${maxWaitMs}`;
  const existing = waiters.get(memoKey);

  if (existing) return existing;

  const created = createSlotWaiter(key, Math.round(60_000 / perMinute), burst, maxWaitMs);

  waiters.set(memoKey, created);

  return created;
}

function createSlotWaiter(
  key: string,
  intervalMs: number,
  burst: number,
  maxWaitMs: number,
): SlotWaiter {
  const localPacer = createLocalPacer(intervalMs, burst);

  // Built on first use, because `createRedisConnection` reads `serverEnv()`.
  // `"command"`, not `"fail-fast"`: the bucket is the source of truth, with no second read.
  let redis: BoundedRedis | null = null;
  let redisUnavailable = false;
  // Time-bound, so pacing rejoins the shared bucket when Redis recovers.
  let redisSuspendedUntil = 0;

  function connection(): BoundedRedis | null {
    if (redisUnavailable) return null;

    if (Date.now() < redisSuspendedUntil) return null;

    if (!redis) {
      if (!isQueueEnabled()) {
        redisUnavailable = true;

        return null;
      }

      try {
        redis = createRedisConnection("command");
      } catch (err) {
        // ioredis throws synchronously on a bad url. A bad url stays bad, so latch for good.
        redisUnavailable = true;
        console.warn("[ai-gateway] redis unavailable, pacing locally:", toMessage(err));

        return null;
      }
    }

    return redis;
  }

  return async (signal, url) => {
    // Check before reserving, or an aborted call burns a slot.
    if (signal?.aborted) throw signal.reason;

    const localWait = localPacer.take(maxWaitMs);

    // Redis could only confirm this refusal, so skip the round trip.
    if (localWait > maxWaitMs) throw overCapRefusal(localWait, maxWaitMs, url);

    let waitMs = localWait;

    // No Redis fault may escape: this runs in `fetch`, and the local pacer suffices alone.
    try {
      const shared = connection();

      if (shared) {
        waitMs = Math.max(
          localWait,
          await reserveRateSlot(shared, key, intervalMs, burst, maxWaitMs),
        );

        // A refused wait must not move the local clock.
        if (waitMs <= maxWaitMs) localPacer.observeHonored(localWait, waitMs);
      }
    } catch (err) {
      redisSuspendedUntil = Date.now() + REDIS_SUSPEND_MS;
      console.warn("[ai-gateway] slot reservation failed, pacing locally:", toMessage(err));
    }

    // Outside the `catch`: this is a verdict, not a Redis fault.
    if (waitMs > maxWaitMs) throw overCapRefusal(waitMs, maxWaitMs, url);

    if (waitMs <= 0) return;

    await sleep(waitMs, signal);
  };
}

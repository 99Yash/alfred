import { toMessage } from "@alfred/contracts";
import { createRedisConnection, isQueueEnabled, reserveRateSlot } from "@alfred/db/redis";
import type { BoundedRedis } from "@alfred/db/redis";

/**
 * Client-side pacing for the Cloudflare AI Gateway.
 *
 * TWO different 429s come back from the gateway edge, and conflating them
 * wasted an afternoon on 2026-09-12. Both carry `latency: 0`, `wholesale:
 * false` and `cost: 0` in the log row, because the edge answers before the
 * provider is called and nothing is billed. Only the body separates them:
 *
 * - `internalCode 2003`, `"Rate limited"` — the gateway's OWN rule, the
 *   `rate_limiting_limit` / `rate_limiting_interval` / `rate_limiting_technique`
 *   fields on the gateway record. This is Alfred's own setting, not a
 *   Cloudflare ceiling. `alfred-dev` carried 14 requests per 6 seconds on a
 *   fixed window (140 per minute) until it was cleared on 2026-09-12, and that
 *   rule — not the budget below — produced every 429 the first diagnosis read
 *   as a budget rejection.
 * - `internalCode 2018`, `"Wholesale Rate limited"` — the Unified Billing
 *   budget, which Cloudflare owns and documents at 200 requests per 60 seconds
 *   per gateway. That published figure does not describe what the pools
 *   actually do; see the measurement below.
 *
 * The wholesale budget is SHARED ACROSS PROVIDERS, one per gateway. Two
 * order-reversed bursts on 2026-09-13, each after a 10-minute quiet period,
 * settle it: 25 OpenAI calls took 19 slots and 15 Google calls fired straight
 * afterwards got 3, then 25 Google calls took 11 and 15 OpenAI calls straight
 * afterwards got 2. Whichever provider goes FIRST takes the slots and the one
 * that goes second starves, at 13-20 percent against 44-76 percent. A
 * per-provider pool cannot produce that shape, because the second burst would
 * be drawing on a bucket nothing had touched.
 *
 * This reverses a 2026-09-12 reading — "Google took 120 per minute sustained
 * and a burst of 40 with zero rejections", "the OpenAI pool is simply
 * unhealthy" — that came from single runs on a bucket earlier probes had
 * already drained. Drain state, not a property of either provider. Do not
 * restore those claims without an order-reversed pair behind them.
 *
 * Read the limit of this module honestly. The budget is a bucket of roughly 15
 * to 25 requests that refills at single digits per minute once drained, not
 * the 200 per 60 seconds Cloudflare documents. One chat turn makes 8 to 16
 * model legs. So pacing spreads Alfred's own fan-out across the budget, and
 * that is all it can do — no client-side rate makes a drained bucket serve,
 * and the degrade leg cannot either, because it draws on the same bucket.
 *
 * Why pace rather than retry: one chat turn makes 8-16 model legs, and a
 * parallel fan-out (sub-agents, a triage batch) can put dozens in flight at
 * once. The retry ladder then fires four attempts inside about three seconds
 * against a bucket that has not refilled, and the turn dies with every tool
 * result already written. Waiting converts that failure into latency.
 *
 * This sits in `fetch` rather than in the agent loop so it covers every caller
 * of the gateway — chat, background boss, cheap classifiers, retries and
 * fallback legs alike — with no call site aware of it. A wait here is charged
 * only to the SDK's `totalMs` (180s for a chat turn), never to a chunk-gap
 * timer: `DEFAULT_TURN_STREAM_TIMEOUT` sets `chunkMs`, and the SDK measures
 * that BETWEEN content chunks. The separate `firstChunkMs` option, which would
 * cover this wait, is deliberately not set.
 */

/**
 * Requests per minute the pacer aims for across the WHOLE gateway, against a
 * documented Unified Billing ceiling of 200 per 60 seconds. The margin absorbs
 * the other things that share the budget — a backfill script, an eval run, a
 * second replica — and the drift between this process's clock and
 * Cloudflare's.
 *
 * Treat 200 as the documented figure, not the measured one. Measured behaviour
 * is a burst allowance near 15 to 25 that then refills at single digits per
 * minute, so this number bounds Alfred's fan-out but cannot keep the budget
 * from draining under sustained load.
 *
 * Do NOT raise this to match a gateway `rate_limiting_limit`. That field is a
 * separate, self-imposed rule; `alfred-dev` has none, and adding one back puts
 * the tighter of the two in charge without changing this number.
 */
const DEFAULT_REQUESTS_PER_MINUTE = 180;

/**
 * How many requests may start with no delay after an idle period. GCRA lets a
 * caller run `burst` intervals ahead of the queue, so the bucket serves
 * `burst + 1` immediately and the worst minute holds `perMinute + burst` — 182
 * against the 200 figure. Small on purpose: at 180 per minute a slot arrives
 * every 333ms, so a SEQUENTIAL agent loop never waits at all and the burst
 * only has to cover the first few legs of a parallel fan-out.
 */
const DEFAULT_BURST = 2;

/**
 * Longest this will hold a request back. Past it the request goes anyway and
 * probably earns a 429, which the retry ladder handles — and that retry re-
 * enters the pacer, so the slot is not lost, only the attempt. The ceiling
 * exists because a wait is charged to the caller's total timeout: a chat turn
 * allows 180s for the whole leg, and no single leg may eat most of it.
 */
const MAX_WAIT_MS = 45_000;

export interface GatewayThrottleConfig {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly requestsPerMinute?: number;
  readonly burst?: number;
}

/**
 * The bucket is keyed by GATEWAY ONLY, never by provider, because one Unified
 * Billing budget covers every provider behind a gateway. Two Alfred processes
 * pointed at one gateway must share this key; one process pointed at two
 * gateways must not.
 *
 * An earlier version carried a `provider` segment here, on a measurement that
 * did not hold (see the header). The field is gone rather than merely unused,
 * so it cannot come back by accident: a provider segment multiplies the
 * effective rate by the number of providers in play — three keys at 180 per
 * minute each is 540 per minute against a budget of roughly 200 — and the
 * pacer would pace nothing at exactly the moment it is needed.
 */
function bucketKey(config: GatewayThrottleConfig): string {
  return `aigw:slot:${config.accountId}:${config.gatewayId}`;
}

/**
 * In-process GCRA, in the same arithmetic as the Lua body in `@alfred/db`.
 *
 * Two jobs, not one. It is the whole pacer when Redis is absent (a script, a
 * test, a local run with no `REDIS_URL`), and it is the floor when Redis is
 * present but momentarily unreachable — a throttle that fails open on a
 * connection blip would send the burst it exists to prevent.
 */
function createLocalPacer(intervalMs: number, burst: number): () => number {
  let theoreticalArrival = 0;

  return () => {
    const now = Date.now();
    const tat = Math.max(theoreticalArrival, now);
    const wait = Math.max(0, tat - burst * intervalMs - now);

    theoreticalArrival = tat + intervalMs;

    return wait;
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

/** Holds a caller until the gateway's budget has room for its request. */
type SlotWaiter = (signal: AbortSignal | undefined) => Promise<void>;

/**
 * One waiter per gateway per process, because the caller cannot give us one.
 *
 * `activeGateway()` builds a fresh `Gateway` — and therefore a fresh set of
 * provider clients — on EVERY leg construction, by design: creation there is
 * pure from config and holds no state. A pacer is the opposite; it is only
 * correct while it remembers the requests already sent. So the sharing lives
 * here rather than at the call site, and a hundred `createGateway` calls in a
 * process resolve to the same waiter, the same local clock and the same Redis
 * handle instead of a hundred empty buckets and a hundred connections.
 *
 * The map is keyed by the budget the waiter guards, not by the gateway alone,
 * so a changed rate gets its own waiter rather than silently reusing the old
 * pace. The key space is env-sized: one entry in practice.
 */
const waiters = new Map<string, SlotWaiter>();

/**
 * Wraps `inner` so every request waits for a slot in the gateway's budget.
 *
 * Pass the provider's own fetch decorator as `inner` when it has one — OpenAI
 * needs its `Authorization` header stripped before the wire — so the two
 * concerns compose instead of one file knowing both.
 */
export function throttledGatewayFetch(
  config: GatewayThrottleConfig,
  inner: typeof globalThis.fetch = fetch,
): typeof globalThis.fetch {
  const waitForSlot = sharedWaiter(config);

  return async (input, init) => {
    await waitForSlot(init?.signal ?? undefined);

    return inner(input, init);
  };
}

function sharedWaiter(config: GatewayThrottleConfig): SlotWaiter {
  const perMinute = config.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
  const burst = config.burst ?? DEFAULT_BURST;
  const key = bucketKey(config);
  const memoKey = `${key}:${perMinute}:${burst}`;
  const existing = waiters.get(memoKey);

  if (existing) return existing;

  const created = createSlotWaiter(key, Math.round(60_000 / perMinute), burst);

  waiters.set(memoKey, created);

  return created;
}

function createSlotWaiter(key: string, intervalMs: number, burst: number): SlotWaiter {
  const localPacer = createLocalPacer(intervalMs, burst);

  // One connection for the process, built on first use rather than at module
  // load: `createRedisConnection` reads `serverEnv()`, and a gateway can be
  // constructed in a process that never makes a call. `"command"` is required
  // here — the bucket IS this caller's source of truth and it gets no second
  // read, which is exactly the case the profile note in `@alfred/db/redis`
  // says must not take `"fail-fast"`.
  let redis: BoundedRedis | null = null;
  let redisUnavailable = false;

  function connection(): BoundedRedis | null {
    if (redisUnavailable) return null;

    if (!redis) {
      if (!isQueueEnabled()) {
        redisUnavailable = true;

        return null;
      }

      redis = createRedisConnection("command");
    }

    return redis;
  }

  return async (signal) => {
    // The local pacer advances on EVERY request, whichever answer is used, so
    // its clock never falls behind the traffic it is the fallback for.
    const localWait = localPacer();
    const shared = connection();
    let waitMs = localWait;

    if (shared) {
      try {
        waitMs = Math.max(localWait, await reserveRateSlot(shared, key, intervalMs, burst));
      } catch (err) {
        console.warn("[ai-gateway] slot reservation failed, pacing locally:", toMessage(err));
      }
    }

    if (waitMs <= 0) return;

    if (waitMs > MAX_WAIT_MS) {
      console.warn(
        `[ai-gateway] gateway budget backed up ${waitMs}ms; sending after ${MAX_WAIT_MS}ms and accepting a possible 429`,
      );
      await sleep(MAX_WAIT_MS, signal);

      return;
    }

    await sleep(waitMs, signal);
  };
}

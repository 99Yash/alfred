import { Errors, isApiError, toMessage } from "@alfred/contracts";
import {
  createRedisConnection,
  incrementExpiringCounter,
  type BoundedRedis,
} from "@alfred/db/redis";
import { Elysia } from "elysia";

/**
 * A per-caller request limit for a route that has NO session.
 *
 * Every other route in this API is bounded by the session check: an anonymous
 * caller never reaches the handler, so nothing has ever needed a limiter beside
 * Better Auth's own (`packages/auth/src/rate-limit.ts`, which covers
 * `/api/auth/*` only). The shared-thread read (ADR-0102) removes that bound and
 * has to replace it.
 *
 * The threat is NOT slug enumeration. A slug carries 80 bits, so walking the
 * space is not a strategy. The threat is cost: one known slug returns a whole
 * transcript, from the database, on every request, to a caller who needs no
 * account. This bounds how often that costs anything.
 *
 * IT FAILS OPEN. A Redis outage must not take the public page down — the page
 * is a read of already-published content, and losing it turns a shared link
 * into a broken promise. The counter is a cost control, not an access control;
 * the access control is the slug.
 */

/** Requests one caller may make per {@link WINDOW_SECONDS}. */
const MAX_REQUESTS_PER_WINDOW = 60;

const WINDOW_SECONDS = 60;

let publicRateRedis: BoundedRedis | undefined;

function getPublicRateRedis(): BoundedRedis {
  // `"command"`, not `"fail-fast"`: a `"fail-fast"` handle rejects its first
  // command after construction even against a healthy Redis, which would make
  // the first public read of every process look rate-limited in the logs.
  publicRateRedis ??= createRedisConnection("command");

  return publicRateRedis;
}

/**
 * Address ranges that are a hop in front of this process rather than a caller.
 *
 * Same list, and the same reasoning, as `TRUSTED_PROXY_RANGES` in
 * `packages/auth/src/rate-limit.ts`: the container is reachable only through
 * Railway's edge, Railway publishes no stable address for it, and every hop
 * between the client and this process is on Railway's internal network.
 */
const INFRASTRUCTURE_PREFIXES = ["10.", "192.168.", "127.", "100.", "::1", "fd", "fc"] as const;

function isInfrastructureHop(address: string): boolean {
  if (address.startsWith("172.")) {
    const second = Number(address.split(".")[1]);

    return Number.isInteger(second) && second >= 16 && second <= 31;
  }

  return INFRASTRUCTURE_PREFIXES.some((prefix) => address.startsWith(prefix));
}

/**
 * The caller's address, read RIGHT TO LEFT out of `x-forwarded-for`.
 *
 * Direction is the whole correctness argument. A proxy APPENDS the address it
 * saw, so the leftmost entry is whatever the client chose to send and the
 * rightmost entries are the hops we trust. Reading from the left would let any
 * caller mint a fresh bucket per request by spoofing one header, which is a
 * limiter that limits nothing. Reading from the right past the infrastructure
 * hops gives the address Railway's edge actually observed.
 *
 * Returns `null` when no address survives that walk. The caller then shares one
 * bucket with every other such request, which is the safe direction: it cannot
 * be widened by spoofing, only narrowed.
 */
export function clientAddressFromForwardedFor(header: string | null | undefined): string | null {
  if (!header) return null;

  const hops = header
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  for (let i = hops.length - 1; i >= 0; i--) {
    // SAFETY: `i` indexes inside the array it was measured from.
    const hop = hops[i]!;

    if (!isInfrastructureHop(hop)) return hop;
  }

  return null;
}

/**
 * Limit the routes declared on the instance this is `use`d by.
 *
 * `onBeforeHandle` rather than a call inside a handler: a second public route
 * added to the same instance then inherits the limit instead of having to
 * remember it, which is the same reason the public routes live on their own
 * Elysia instance at all.
 */
export function publicRateLimit(bucket: string): Elysia {
  return new Elysia({ name: `public-rate-limit-${bucket}` }).onBeforeHandle(async ({ request }) => {
    const caller = clientAddressFromForwardedFor(request.headers.get("x-forwarded-for"));
    const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const key = `ratelimit:public:${bucket}:${caller ?? "unknown"}:${window}`;

    try {
      const count = await incrementExpiringCounter(
        getPublicRateRedis(),
        key,
        1,
        // Two windows of TTL so a key minted at the end of one window is not
        // reclaimed while it is still the current bucket.
        WINDOW_SECONDS * 2,
      );

      if (count > MAX_REQUESTS_PER_WINDOW) {
        throw Errors.TooManyRequestsError("Too many requests. Try again in a minute.", {
          retryAfterSeconds: WINDOW_SECONDS,
        });
      }
    } catch (err) {
      // The rejection above rides the same `catch` as a Redis failure, so let
      // it through: only an infrastructure error fails open.
      if (isApiError(err, "TOO_MANY_REQUESTS")) throw err;

      console.warn("[sharing] public rate limit unavailable:", toMessage(err));
    }
  });
}

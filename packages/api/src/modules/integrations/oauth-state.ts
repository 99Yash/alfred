import { serverEnv } from "@alfred/env/server";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import type IORedis from "ioredis";
import { createRedisConnection } from "../../queue/connection";

/**
 * Server-side OAuth state nonce store.
 *
 * On `connect`, we mint a random nonce, persist `nonce → userId` in Redis
 * with a 10-minute TTL, and embed the nonce in the (HMAC-signed) `state`
 * parameter sent to the IdP. On `callback`, we atomically pop the nonce
 * — if it's missing or already consumed, the request is rejected. This
 * is the actual CSRF/replay defense; the HMAC only proves the state
 * wasn't fabricated client-side. Without persistence, a leaked signed
 * state would let an attacker bind their IdP account to a victim's
 * Alfred user (since the userId is encoded in the state).
 */

const KEY_PREFIX = "oauth:state:";
const DEFAULT_TTL_SECONDS = 600; // 10 minutes — generous for slow IdP redirects

let _client: IORedis | undefined;
function client(): IORedis {
  if (!_client) _client = createRedisConnection();
  return _client;
}

export interface IssueNonceArgs {
  nonce: string;
  userId: string;
  /** Provider tag (`google`, `slack`, …) so nonces can't cross-pollinate. */
  provider: string;
  ttlSeconds?: number;
}

export async function rememberOAuthNonce(args: IssueNonceArgs): Promise<void> {
  const ttl = args.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  await client().set(key(args.provider, args.nonce), args.userId, "EX", ttl);
}

/**
 * Atomically read-and-delete the nonce. Returns the userId that minted
 * it, or null if the nonce is unknown / already consumed / expired.
 */
export async function consumeOAuthNonce(provider: string, nonce: string): Promise<string | null> {
  const v = await client().getdel(key(provider, nonce));
  return v ?? null;
}

function key(provider: string, nonce: string): string {
  return `${KEY_PREFIX}${provider}:${nonce}`;
}

/**
 * HMAC-signed `state` carrying `(userId, nonce)`. The signature (keyed on
 * `BETTER_AUTH_SECRET`) proves the state wasn't fabricated client-side; the
 * nonce (above) is the real replay defense. The single definition of this
 * security-sensitive check — every integration's connect/callback route
 * (Google, GitHub, Notion, Vercel) signs and verifies through these.
 */
const signedOAuthStateSchema = z.object({
  userId: z.string(),
  nonce: z.string(),
});

export type SignedOAuthState = z.infer<typeof signedOAuthStateSchema>;

export function signOAuthState(state: SignedOAuthState): string {
  const env = serverEnv();
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyOAuthState(raw: string): SignedOAuthState | null {
  const env = serverEnv();
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = signedOAuthStateSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

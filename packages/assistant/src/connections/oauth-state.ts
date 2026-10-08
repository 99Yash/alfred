import type { CredentialProvider } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { workflowRecoveryStateSchema } from "./ingestion/workflow-recovery";

/**
 * OAuth state nonces in Redis. The one-time nonce is the CSRF and replay defense;
 * the HMAC only proves the state was not forged. Without it, a leaked state
 * could bind an attacker's account to a victim's user.
 */

const KEY_PREFIX = "oauth:state:";

const DEFAULT_TTL_SECONDS = 600; // generous for slow IdP redirects

let _client: BoundedRedis | undefined;

function client(): BoundedRedis {
  if (!_client) _client = createRedisConnection("command");

  return _client;
}

/** A callback can only consume a nonce its own connect route minted. */
export type OAuthNonceNamespace = CredentialProvider | `mcp:${string}`;

export interface IssueNonceArgs {
  nonce: string;
  userId: string;
  provider: OAuthNonceNamespace;
  ttlSeconds?: number;
}

export async function rememberOAuthNonce(args: IssueNonceArgs): Promise<void> {
  const ttl = args.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  await client().set(key(args.provider, args.nonce), args.userId, "EX", ttl);
}

/** Atomic read-and-delete. `null` if unknown, used, or expired. */
export async function consumeOAuthNonce(
  provider: OAuthNonceNamespace,
  nonce: string,
): Promise<string | null> {
  const v = await client().getdel(key(provider, nonce));

  return v ?? null;
}

function key(provider: OAuthNonceNamespace, nonce: string): string {
  return `${KEY_PREFIX}${provider}:${nonce}`;
}

/** HMAC-signed with `BETTER_AUTH_SECRET`. Every connect route signs and verifies here. */
const signedOAuthStateSchema = z.object({
  userId: z.string(),
  nonce: z.string(),
  /** For flows that resume one durable connection. */
  connectionId: z.string().optional(),
  /** The workflow draft to revalidate when OAuth returns. */
  workflowRecovery: workflowRecoveryStateSchema.optional(),
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

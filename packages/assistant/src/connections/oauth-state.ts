import { Errors, type CredentialProvider } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRedisConnection, type BoundedRedis } from "@alfred/db/redis";
import { workflowRecoveryStateSchema } from "./ingestion/workflow-recovery";

/**
 * OAuth state nonces in Redis. The one-time nonce is the CSRF and replay defense;
 * the HMAC only proves the state was not forged. Without it, a leaked state
 * could bind an attacker's account to a victim's user.
 *
 * Curated provider routes use `oauthHandshake(provider)`, which runs every check in one
 * operation. The four primitives below stay exported only for the MCP flow, whose nonce
 * namespace and encoding differ; `pnpm check` (`oauth-state-primitive`) holds that line.
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

/** What a curated connect route carries through the provider redirect and gets back on callback. */
export type OAuthHandshakeState = Omit<SignedOAuthState, "nonce" | "connectionId">;

export interface OAuthHandshake {
  /** Mints and remembers a one-time nonce for `state.userId`, then returns the signed `state` param. */
  begin(state: OAuthHandshakeState): Promise<string>;
  /**
   * Accepts a callback `state` once. In order: HMAC and shape (400 "Invalid state"), then the
   * nonce is consumed, then it must have been minted for the same user (400 "Invalid or expired
   * state"). The nonce is consumed before the user check, so a mismatched state is still spent.
   */
  complete(rawState: string): Promise<OAuthHandshakeState>;
}

/**
 * The state handshake for one curated provider. Bind it once per route module, so connect and
 * callback share the nonce namespace: a callback can only consume a nonce its own connect minted.
 */
export function oauthHandshake(provider: CredentialProvider): OAuthHandshake {
  return {
    async begin({ userId, ...extras }) {
      const nonce = randomBytes(16).toString("hex");
      await rememberOAuthNonce({ provider, nonce, userId });

      return signOAuthState({ userId, nonce, ...extras });
    },
    async complete(rawState) {
      const decoded = verifyOAuthState(rawState);

      if (!decoded) throw Errors.BadRequestError("Invalid state");
      const storedUserId = await consumeOAuthNonce(provider, decoded.nonce);

      if (!storedUserId || storedUserId !== decoded.userId) {
        throw Errors.BadRequestError("Invalid or expired state");
      }

      return decoded;
    },
  };
}

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
 * Every OAuth flow, curated provider or MCP, uses `oauthHandshake(flow)`, which runs every
 * check in one operation. The primitives below are module-private; `pnpm check`
 * (`oauth-state-primitive`) keeps them out of every other file.
 */

const KEY_PREFIX = "oauth:state:";

const NONCE_TTL_SECONDS = 600; // generous for slow IdP redirects

let _client: BoundedRedis | undefined;

function client(): BoundedRedis {
  if (!_client) _client = createRedisConnection("command");

  return _client;
}

/** A callback can only consume a nonce its own connect route minted. */
type OAuthNonceNamespace = CredentialProvider | `mcp:${string}`;

async function rememberOAuthNonce(
  namespace: OAuthNonceNamespace,
  nonce: string,
  userId: string,
): Promise<void> {
  await client().set(key(namespace, nonce), userId, "EX", NONCE_TTL_SECONDS);
}

/** Atomic read-and-delete. `null` if unknown, used, or expired. */
async function consumeOAuthNonce(
  namespace: OAuthNonceNamespace,
  nonce: string,
): Promise<string | null> {
  const v = await client().getdel(key(namespace, nonce));

  return v ?? null;
}

function key(namespace: OAuthNonceNamespace, nonce: string): string {
  return `${KEY_PREFIX}${namespace}:${nonce}`;
}

/** HMAC-signed with `BETTER_AUTH_SECRET`. Every OAuth flow signs and verifies here. */
const signedOAuthStateSchema = z.object({
  userId: z.string(),
  nonce: z.string(),
  /** The MCP connection the authorization resumes. It also names that flow's nonce namespace. */
  connectionId: z.string().optional(),
  /** The workflow draft to revalidate when OAuth returns. */
  workflowRecovery: workflowRecoveryStateSchema.optional(),
});

type SignedOAuthState = z.infer<typeof signedOAuthStateSchema>;

function signOAuthState(state: SignedOAuthState): string {
  const env = serverEnv();
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(payload).digest("base64url");

  return `${payload}.${sig}`;
}

function verifyOAuthState(raw: string): SignedOAuthState | null {
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

/** What an MCP authorization carries: the user and the one connection it resumes. */
export interface McpOAuthHandshakeState {
  userId: string;
  connectionId: string;
}

export interface OAuthHandshake<State = OAuthHandshakeState> {
  /** Mints and remembers a one-time nonce for `state.userId`, then returns the signed `state` param. */
  begin(state: State): Promise<string>;
  /**
   * Accepts a callback `state` once. In order: HMAC and shape (400 "Invalid state"), then the
   * nonce is consumed, then it must have been minted for the same user (400 "Invalid or expired
   * state"). The nonce is consumed before the user check, so a mismatched state is still spent.
   * The MCP flow says "OAuth state" in both messages, and a state that names no connection is
   * an invalid one.
   */
  complete(rawState: string): Promise<State>;
}

/** How one flow names its nonce namespace and reads its own state out of a verified payload. */
interface HandshakeFlow<State extends Omit<SignedOAuthState, "nonce">> {
  namespace(state: State): OAuthNonceNamespace;
  /** `null` when the verified payload is not shaped for this flow. */
  accept(signed: SignedOAuthState): State | null;
  invalidMessage: string;
  expiredMessage: string;
}

function handshake<State extends Omit<SignedOAuthState, "nonce">>(
  flow: HandshakeFlow<State>,
): OAuthHandshake<State> {
  return {
    async begin(state) {
      const nonce = randomBytes(16).toString("hex");
      await rememberOAuthNonce(flow.namespace(state), nonce, state.userId);

      return signOAuthState({ ...state, nonce });
    },
    async complete(rawState) {
      const signed = verifyOAuthState(rawState);
      const state = signed ? flow.accept(signed) : null;

      if (!signed || !state) throw Errors.BadRequestError(flow.invalidMessage);
      const storedUserId = await consumeOAuthNonce(flow.namespace(state), signed.nonce);

      if (!storedUserId || storedUserId !== state.userId) {
        throw Errors.BadRequestError(flow.expiredMessage);
      }

      return state;
    },
  };
}

/**
 * The state handshake for one OAuth flow. Bind it once per route module, so connect and callback
 * share the nonce namespace: a callback can only consume a nonce its own connect minted.
 *
 * A curated provider is one namespace. `"mcp"` namespaces each nonce by the connection that the
 * signed state names (`mcp:<connectionId>`), so a callback cannot spend a nonce that was minted
 * for a different MCP connection.
 */
export function oauthHandshake(provider: CredentialProvider): OAuthHandshake;
export function oauthHandshake(flow: "mcp"): OAuthHandshake<McpOAuthHandshakeState>;
export function oauthHandshake(
  flow: CredentialProvider | "mcp",
): OAuthHandshake | OAuthHandshake<McpOAuthHandshakeState> {
  if (flow === "mcp") {
    return handshake<McpOAuthHandshakeState>({
      namespace: ({ connectionId }) => `mcp:${connectionId}`,
      accept: ({ userId, connectionId }) => (connectionId ? { userId, connectionId } : null),
      invalidMessage: "Invalid OAuth state",
      expiredMessage: "Invalid or expired OAuth state",
    });
  }

  return handshake<OAuthHandshakeState>({
    namespace: () => flow,
    accept: (signed) => signed,
    invalidMessage: "Invalid state",
    expiredMessage: "Invalid or expired state",
  });
}

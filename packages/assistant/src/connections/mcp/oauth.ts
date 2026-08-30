import { db } from "@alfred/db";
import { credentialVault, type CredentialVault } from "@alfred/db/credential-vault";
import {
  mcpConnections,
  mcpOauthAuthorizationAttempts,
  mcpOauthCredentials,
  type McpOauthAuthorizationAttempt,
  type McpOauthCredential,
  type NewMcpOauthCredential,
} from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import {
  auth,
  StreamableHTTPClientTransport,
  validateClientMetadataUrl,
  type AuthorizationServerMetadata,
  type AuthResult,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthProtectedResourceMetadata,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { and, eq, gt, lt } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { rememberOAuthNonce, signOAuthState } from "@alfred/assistant/connections";

const oauthMetadataSchema = z.looseObject({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  response_types_supported: z.array(z.string()),
  registration_endpoint: z.string().url().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

const protectedResourceMetadataSchema = z.looseObject({
  resource: z.string(),
  authorization_servers: z.array(z.string().url()).optional(),
});

const discoveryStateSchema = z.object({
  authorizationServerUrl: z.string().url(),
  resourceMetadataUrl: z.string().url().optional(),
  authorizationServerMetadata: oauthMetadataSchema.optional(),
  resourceMetadata: protectedResourceMetadataSchema.optional(),
});

const clientInformationSchema = z.looseObject({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  issuer: z.string().url().optional(),
});

const oauthTokensSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.coerce.number().int().nonnegative().optional(),
  scope: z.string().optional(),
  issuer: z.string().url().optional(),
});

const MCP_OAUTH_FETCH_TIMEOUT_MS = 30_000;
const MCP_OAUTH_REFRESH_SKEW_MS = 60_000;
const MCP_OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;

type OAuthCredentialPatch = Partial<
  Pick<
    NewMcpOauthCredential,
    | "discoveryState"
    | "clientInformation"
    | "clientSecret"
    | "accessToken"
    | "refreshToken"
    | "idToken"
    | "tokenType"
    | "expiresIn"
    | "scope"
    | "lastAuthorizedAt"
  >
>;

export interface McpOAuthCredentialStore {
  readForConnection(connectionId: string, userId: string): Promise<McpOauthCredential | undefined>;
  attachDiscovery(input: {
    connectionId: string;
    userId: string;
    issuer: string;
    discoveryState: OAuthDiscoveryState;
  }): Promise<McpOauthCredential>;
  update(id: string, userId: string, patch: OAuthCredentialPatch): Promise<void>;
  createAttempt(input: {
    connectionId: string;
    userId: string;
    stateHash: string;
  }): Promise<McpOauthAuthorizationAttempt>;
  readAttempt(input: {
    connectionId: string;
    userId: string;
    stateHash: string;
  }): Promise<McpOauthAuthorizationAttempt | undefined>;
  saveAttemptCodeVerifier(input: {
    stateHash: string;
    userId: string;
    codeVerifier: McpOauthAuthorizationAttempt["codeVerifier"];
  }): Promise<void>;
  deleteAttempt(stateHash: string, userId: string): Promise<void>;
  updateConnectionAuthorization(input: {
    connectionId: string;
    userId: string;
    grantedScopes: string[];
  }): Promise<void>;
}

class DbMcpOAuthCredentialStore implements McpOAuthCredentialStore {
  async readForConnection(
    connectionId: string,
    userId: string,
  ): Promise<McpOauthCredential | undefined> {
    const [row] = await db()
      .select({ credential: mcpOauthCredentials })
      .from(mcpConnections)
      .innerJoin(mcpOauthCredentials, eq(mcpOauthCredentials.id, mcpConnections.credentialId))
      .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.userId, userId)))
      .limit(1);
    return row?.credential;
  }

  async attachDiscovery(input: {
    connectionId: string;
    userId: string;
    issuer: string;
    discoveryState: OAuthDiscoveryState;
  }): Promise<McpOauthCredential> {
    return db().transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: mcpConnections.id })
        .from(mcpConnections)
        .where(
          and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
        )
        .limit(1);
      if (!owned) throw new Error("MCP OAuth connection does not belong to this user");

      const [existing] = await tx
        .select({ issuer: mcpOauthCredentials.issuer })
        .from(mcpOauthCredentials)
        .where(eq(mcpOauthCredentials.connectionId, input.connectionId))
        .limit(1);
      if (existing && existing.issuer !== input.issuer) {
        throw new Error("MCP OAuth authorization server changed for this connection");
      }

      const [credential] = await tx
        .insert(mcpOauthCredentials)
        .values({
          userId: input.userId,
          connectionId: input.connectionId,
          issuer: input.issuer,
          discoveryState: input.discoveryState,
        })
        .onConflictDoUpdate({
          target: mcpOauthCredentials.connectionId,
          set: {
            discoveryState: input.discoveryState,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!credential) throw new Error("MCP OAuth discovery upsert returned no row");

      await tx
        .update(mcpConnections)
        .set({
          credentialId: credential.id,
          authServerIdentity: input.issuer,
          updatedAt: new Date(),
        })
        .where(
          and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
        );
      return credential;
    });
  }

  async update(id: string, userId: string, patch: OAuthCredentialPatch): Promise<void> {
    await db()
      .update(mcpOauthCredentials)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(mcpOauthCredentials.id, id), eq(mcpOauthCredentials.userId, userId)));
  }

  async createAttempt(input: {
    connectionId: string;
    userId: string;
    stateHash: string;
  }): Promise<McpOauthAuthorizationAttempt> {
    return db().transaction(async (tx) => {
      const now = new Date();
      await tx
        .delete(mcpOauthAuthorizationAttempts)
        .where(
          and(
            eq(mcpOauthAuthorizationAttempts.connectionId, input.connectionId),
            lt(mcpOauthAuthorizationAttempts.expiresAt, now),
          ),
        );
      const [attempt] = await tx
        .insert(mcpOauthAuthorizationAttempts)
        .values({
          ...input,
          expiresAt: new Date(now.getTime() + MCP_OAUTH_ATTEMPT_TTL_MS),
        })
        .returning();
      if (!attempt) throw new Error("MCP OAuth attempt insert returned no row");
      return attempt;
    });
  }

  async readAttempt(input: {
    connectionId: string;
    userId: string;
    stateHash: string;
  }): Promise<McpOauthAuthorizationAttempt | undefined> {
    const [attempt] = await db()
      .select()
      .from(mcpOauthAuthorizationAttempts)
      .where(
        and(
          eq(mcpOauthAuthorizationAttempts.connectionId, input.connectionId),
          eq(mcpOauthAuthorizationAttempts.userId, input.userId),
          eq(mcpOauthAuthorizationAttempts.stateHash, input.stateHash),
          gt(mcpOauthAuthorizationAttempts.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return attempt;
  }

  async saveAttemptCodeVerifier(input: {
    stateHash: string;
    userId: string;
    codeVerifier: McpOauthAuthorizationAttempt["codeVerifier"];
  }): Promise<void> {
    await db()
      .update(mcpOauthAuthorizationAttempts)
      .set({ codeVerifier: input.codeVerifier, updatedAt: new Date() })
      .where(
        and(
          eq(mcpOauthAuthorizationAttempts.stateHash, input.stateHash),
          eq(mcpOauthAuthorizationAttempts.userId, input.userId),
        ),
      );
  }

  async deleteAttempt(stateHashValue: string, userId: string): Promise<void> {
    await db()
      .delete(mcpOauthAuthorizationAttempts)
      .where(
        and(
          eq(mcpOauthAuthorizationAttempts.stateHash, stateHashValue),
          eq(mcpOauthAuthorizationAttempts.userId, userId),
        ),
      );
  }

  async updateConnectionAuthorization(input: {
    connectionId: string;
    userId: string;
    grantedScopes: string[];
  }): Promise<void> {
    await db()
      .update(mcpConnections)
      .set({
        grantedScopes: input.grantedScopes,
        requiredScopes: [],
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(mcpConnections.id, input.connectionId), eq(mcpConnections.userId, input.userId)),
      );
  }
}

const DEFAULT_STORE = new DbMcpOAuthCredentialStore();
const authorizationFlights = new Map<string, Promise<AuthResult>>();

function canonicalIssuer(value: string): string {
  return new URL(value).href;
}

function stateHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeList(scope: string | undefined): string[] {
  return scope?.split(/\s+/).filter(Boolean) ?? [];
}

function parseAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata {
  const parsed = oauthMetadataSchema.parse(value);
  return {
    issuer: parsed.issuer,
    authorization_endpoint: parsed.authorization_endpoint,
    token_endpoint: parsed.token_endpoint,
    response_types_supported: parsed.response_types_supported,
    ...(parsed.registration_endpoint
      ? { registration_endpoint: parsed.registration_endpoint }
      : {}),
    ...(parsed.client_id_metadata_document_supported !== undefined
      ? {
          client_id_metadata_document_supported: parsed.client_id_metadata_document_supported,
        }
      : {}),
    ...(parsed.authorization_response_iss_parameter_supported !== undefined
      ? {
          authorization_response_iss_parameter_supported:
            parsed.authorization_response_iss_parameter_supported,
        }
      : {}),
  };
}

function parseProtectedResourceMetadata(value: unknown): OAuthProtectedResourceMetadata {
  const parsed = protectedResourceMetadataSchema.parse(value);
  return {
    resource: parsed.resource,
    ...(parsed.authorization_servers
      ? { authorization_servers: parsed.authorization_servers }
      : {}),
  };
}

function parseDiscoveryState(value: unknown): OAuthDiscoveryState {
  const parsed = discoveryStateSchema.parse(value);
  return {
    authorizationServerUrl: parsed.authorizationServerUrl,
    ...(parsed.resourceMetadataUrl ? { resourceMetadataUrl: parsed.resourceMetadataUrl } : {}),
    ...(parsed.authorizationServerMetadata
      ? {
          authorizationServerMetadata: parseAuthorizationServerMetadata(
            parsed.authorizationServerMetadata,
          ),
        }
      : {}),
    ...(parsed.resourceMetadata
      ? { resourceMetadata: parseProtectedResourceMetadata(parsed.resourceMetadata) }
      : {}),
  };
}

export class McpOAuthAuthorizationRequiredError extends Error {
  readonly authorizationUrl: URL;

  constructor(authorizationUrl: URL) {
    super("MCP authorization requires user consent");
    this.name = "McpOAuthAuthorizationRequiredError";
    this.authorizationUrl = new URL(authorizationUrl.href);
  }
}

export interface McpOAuthProviderOptions {
  connectionId: string;
  userId: string;
  endpoint: URL;
  redirectUrl: URL;
  clientMetadataUrl?: string;
  clientMetadata: OAuthClientMetadata;
  store?: McpOAuthCredentialStore;
  vault?: CredentialVault;
}

/**
 * SDK OAuth provider backed by Alfred's issuer-keyed encrypted credential row.
 *
 * The provider is used by the explicit authorization coordinator only. The MCP
 * HTTP transport receives a token-only projection, so transport recovery cannot
 * refresh or replay an in-flight `tools/call`.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly #connectionId: string;
  readonly #userId: string;
  readonly #store: McpOAuthCredentialStore;
  readonly #vault: CredentialVault;
  #attemptStateHash: string | null = null;
  readonly redirectUrl: URL;
  readonly clientMetadataUrl?: string;
  readonly clientMetadata: OAuthClientMetadata;

  constructor(options: McpOAuthProviderOptions) {
    this.#connectionId = options.connectionId;
    this.#userId = options.userId;
    this.#store = options.store ?? DEFAULT_STORE;
    this.#vault = options.vault ?? credentialVault();
    this.redirectUrl = new URL(options.redirectUrl.href);
    this.clientMetadata = options.clientMetadata;
    if (options.clientMetadataUrl) {
      validateClientMetadataUrl(options.clientMetadataUrl);
      this.clientMetadataUrl = options.clientMetadataUrl;
    }
  }

  get authorizationKey(): string {
    return `${this.#userId}:${this.#connectionId}`;
  }

  async state(): Promise<string> {
    const nonce = randomBytes(24).toString("base64url");
    await rememberOAuthNonce({
      provider: `mcp:${this.#connectionId}`,
      nonce,
      userId: this.#userId,
    });
    const state = signOAuthState({
      userId: this.#userId,
      nonce,
      connectionId: this.#connectionId,
    });
    this.#attemptStateHash = stateHash(state);
    await this.#store.createAttempt({
      connectionId: this.#connectionId,
      userId: this.#userId,
      stateHash: this.#attemptStateHash,
    });
    return state;
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const credential = await this.#credentialForIssuer(ctx?.issuer);
    if (!credential?.clientInformation) return undefined;
    const parsed = clientInformationSchema.safeParse(credential.clientInformation);
    if (!parsed.success) throw new Error("Persisted MCP OAuth client information is invalid");
    const secret = credential.clientSecret ? this.#vault.open(credential.clientSecret) : undefined;
    return {
      ...parsed.data,
      issuer: credential.issuer,
      ...(secret ? { client_secret: secret } : {}),
    };
  }

  async saveClientInformation(
    value: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    const parsed = clientInformationSchema.parse(value);
    const issuer = canonicalIssuer(ctx?.issuer ?? parsed.issuer ?? "");
    const credential = await this.#requireCredential(issuer);
    const { client_secret: clientSecret, ...publicInformation } = parsed;
    await this.#store.update(credential.id, this.#userId, {
      clientInformation: { ...publicInformation, issuer },
      clientSecret: clientSecret ? this.#vault.seal(clientSecret) : null,
    });
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const credential = await this.#credentialForIssuer(ctx?.issuer);
    if (!credential?.accessToken || !credential.tokenType) return undefined;
    return {
      access_token: this.#vault.open(credential.accessToken),
      token_type: credential.tokenType,
      issuer: credential.issuer,
      ...(credential.refreshToken
        ? { refresh_token: this.#vault.open(credential.refreshToken) }
        : {}),
      ...(credential.idToken ? { id_token: this.#vault.open(credential.idToken) } : {}),
      ...(credential.expiresIn !== null ? { expires_in: credential.expiresIn } : {}),
      ...(credential.scope ? { scope: credential.scope } : {}),
    };
  }

  async saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const parsed = oauthTokensSchema.parse(value);
    const issuer = canonicalIssuer(ctx?.issuer ?? parsed.issuer ?? "");
    const credential = await this.#requireCredential(issuer);
    const vault = this.#vault;
    await this.#store.update(credential.id, this.#userId, {
      accessToken: vault.seal(parsed.access_token),
      // RFC 6749 permits refresh responses to omit the prior refresh token.
      refreshToken: parsed.refresh_token
        ? vault.seal(parsed.refresh_token)
        : credential.refreshToken,
      idToken: parsed.id_token ? vault.seal(parsed.id_token) : credential.idToken,
      tokenType: parsed.token_type,
      expiresIn: parsed.expires_in ?? null,
      scope: parsed.scope ?? credential.scope,
      lastAuthorizedAt: new Date(),
    });
    await this.#store.updateConnectionAuthorization({
      connectionId: this.#connectionId,
      userId: this.#userId,
      grantedScopes: scopeList(parsed.scope ?? credential.scope ?? undefined),
    });
    if (this.#attemptStateHash) {
      await this.#store.deleteAttempt(this.#attemptStateHash, this.#userId);
      this.#attemptStateHash = null;
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<never> {
    throw new McpOAuthAuthorizationRequiredError(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const attemptStateHash = this.#requireAttemptStateHash();
    await this.#store.saveAttemptCodeVerifier({
      stateHash: attemptStateHash,
      userId: this.#userId,
      codeVerifier: this.#vault.seal(codeVerifier),
    });
  }

  async codeVerifier(): Promise<string> {
    const attemptStateHash = this.#requireAttemptStateHash();
    const attempt = await this.#store.readAttempt({
      connectionId: this.#connectionId,
      userId: this.#userId,
      stateHash: attemptStateHash,
    });
    if (!attempt?.codeVerifier) throw new Error("MCP OAuth PKCE verifier is missing");
    return this.#vault.open(attempt.codeVerifier);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const parsed = parseDiscoveryState(state);
    const issuer = canonicalIssuer(
      parsed.authorizationServerMetadata?.issuer ?? parsed.authorizationServerUrl,
    );
    await this.#store.attachDiscovery({
      connectionId: this.#connectionId,
      userId: this.#userId,
      issuer,
      discoveryState: parsed,
    });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const credential = await this.#store.readForConnection(this.#connectionId, this.#userId);
    if (!credential?.discoveryState) return undefined;
    try {
      return parseDiscoveryState(credential.discoveryState);
    } catch {
      throw new Error("Persisted MCP OAuth discovery state is invalid");
    }
  }

  async matchesState(state: string): Promise<boolean> {
    const candidate = stateHash(state);
    const attempt = await this.#store.readAttempt({
      connectionId: this.#connectionId,
      userId: this.#userId,
      stateHash: candidate,
    });
    if (!attempt) return false;
    this.#attemptStateHash = candidate;
    return true;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const credential = await this.#store.readForConnection(this.#connectionId, this.#userId);
    if (!credential) return;
    const patches = {
      all: {
        accessToken: null,
        refreshToken: null,
        idToken: null,
        clientInformation: null,
        clientSecret: null,
        discoveryState: null,
      },
      client: { clientInformation: null, clientSecret: null },
      tokens: { accessToken: null, refreshToken: null, idToken: null },
      verifier: {},
      discovery: { discoveryState: null },
    } satisfies Record<typeof scope, OAuthCredentialPatch>;
    await this.#store.update(credential.id, this.#userId, patches[scope]);
    if ((scope === "all" || scope === "verifier") && this.#attemptStateHash) {
      await this.#store.deleteAttempt(this.#attemptStateHash, this.#userId);
      this.#attemptStateHash = null;
    }
  }

  async authorizationNeedsRefresh(now = Date.now()): Promise<boolean> {
    const credential = await this.#store.readForConnection(this.#connectionId, this.#userId);
    if (
      !credential?.accessToken ||
      credential.expiresIn === null ||
      credential.lastAuthorizedAt === null
    ) {
      return false;
    }
    const expiresAt = credential.lastAuthorizedAt.getTime() + credential.expiresIn * 1_000;
    return expiresAt <= now + MCP_OAUTH_REFRESH_SKEW_MS;
  }

  async #credentialForIssuer(issuer?: string): Promise<McpOauthCredential | undefined> {
    const credential = await this.#store.readForConnection(this.#connectionId, this.#userId);
    if (!credential || !issuer) return credential;
    return credential.issuer === canonicalIssuer(issuer) ? credential : undefined;
  }

  async #requireCredential(issuer?: string): Promise<McpOauthCredential> {
    const credential = await this.#credentialForIssuer(issuer);
    if (!credential) throw new Error("MCP OAuth discovery state is missing");
    return credential;
  }

  #requireAttemptStateHash(): string {
    if (!this.#attemptStateHash) throw new Error("MCP OAuth authorization attempt is missing");
    return this.#attemptStateHash;
  }
}

export interface McpOAuthClientConfiguration {
  redirectUrl: URL;
  clientMetadataUrl?: string;
  clientMetadata: OAuthClientMetadata;
}

export function mcpOAuthClientConfiguration(): McpOAuthClientConfiguration {
  const env = serverEnv();
  const apiBase = new URL(env.BETTER_AUTH_URL);
  const redirectUrl = new URL("/api/integrations/mcp/callback", apiBase);
  const candidateMetadataUrl = new URL("/api/integrations/mcp/client-metadata", apiBase);
  const clientMetadata: OAuthClientMetadata = {
    redirect_uris: [redirectUrl.href],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    client_name: "Alfred",
    client_uri: env.CORS_ORIGIN,
  };
  return {
    redirectUrl,
    clientMetadata,
    ...(candidateMetadataUrl.protocol === "https:"
      ? { clientMetadataUrl: candidateMetadataUrl.href }
      : {}),
  };
}

export function mcpOAuthProviderForConnection(input: {
  connectionId: string;
  userId: string;
  endpoint: URL;
}): McpOAuthProvider {
  return new McpOAuthProvider({
    ...input,
    ...mcpOAuthClientConfiguration(),
  });
}

function timeoutBoundFetch(fetchFn: FetchLike, timeoutMs: number): FetchLike {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchFn(input, { ...init, signal });
  };
}

/** Run refresh/discovery/consent before constructing the token-only transport. */
export function authorizeMcpOAuth(
  provider: OAuthClientProvider,
  endpoint: URL,
  options: {
    fetch: FetchLike;
    forceReauthorization?: boolean;
    scope?: string;
    timeoutMs?: number;
  },
): Promise<AuthResult> {
  const fetchFn = timeoutBoundFetch(options.fetch, options.timeoutMs ?? MCP_OAUTH_FETCH_TIMEOUT_MS);
  const run = () =>
    auth(provider, {
      serverUrl: endpoint,
      fetchFn,
      ...(options.forceReauthorization ? { forceReauthorization: true } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    });
  if (!(provider instanceof McpOAuthProvider)) return run();
  const flightKey = [
    provider.authorizationKey,
    options.forceReauthorization ? "force" : "normal",
    options.scope ?? "",
  ].join(":");
  const existing = authorizationFlights.get(flightKey);
  if (existing) return existing;
  const flight = run().finally(() => {
    if (authorizationFlights.get(flightKey) === flight) {
      authorizationFlights.delete(flightKey);
    }
  });
  authorizationFlights.set(flightKey, flight);
  return flight;
}

/** Refresh before a known expiry, while the call is still pre-delivery. */
export async function refreshMcpOAuthIfNeeded(
  provider: OAuthClientProvider,
  endpoint: URL,
  options: { fetch: FetchLike; timeoutMs?: number },
): Promise<void> {
  if (!(provider instanceof McpOAuthProvider)) return;
  if (!(await provider.authorizationNeedsRefresh())) return;
  await authorizeMcpOAuth(provider, endpoint, options);
}

/**
 * Complete the callback through the SDK's URLSearchParams overload. It validates
 * `iss` against persisted discovery before it reads callback error text or
 * redeems the code.
 */
export async function finishMcpOAuth(
  provider: OAuthClientProvider,
  endpoint: URL,
  callbackParams: URLSearchParams,
  options: { fetch: FetchLike; timeoutMs?: number },
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: provider,
    onInsufficientScope: "throw",
    fetch: timeoutBoundFetch(options.fetch, options.timeoutMs ?? MCP_OAUTH_FETCH_TIMEOUT_MS),
  });
  await transport.finishAuth(callbackParams);
}

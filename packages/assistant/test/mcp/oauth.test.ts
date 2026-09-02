import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createCredentialVault } from "@alfred/db/credential-vault";
import type { McpOauthAuthorizationAttempt, McpOauthCredential } from "@alfred/db/schemas";
import {
  exchangeAuthorization,
  IssuerMismatchError,
  selectClientAuthMethod,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import { createHash, randomBytes } from "node:crypto";
import {
  authorizeMcpOAuth,
  finishMcpOAuth,
  McpOAuthProvider,
  refreshMcpOAuthIfNeeded,
  type McpOAuthCredentialStore,
} from "../../src/connections/mcp/oauth";
import { GITHUB_MCP_ENDPOINT_HREF, GITHUB_MCP_ISSUER } from "../../src/connections/mcp/constants";

class MemoryStore implements McpOAuthCredentialStore {
  row: McpOauthCredential | undefined;
  readonly attempts = new Map<string, McpOauthAuthorizationAttempt>();
  grantedScopes: string[] = [];

  async readForConnection(): Promise<McpOauthCredential | undefined> {
    return this.row;
  }

  async attachDiscovery(input: {
    connectionId: string;
    userId: string;
    issuer: string;
    discoveryState: OAuthDiscoveryState;
  }): Promise<McpOauthCredential> {
    const now = new Date();
    this.row = {
      id: "mcpo_test",
      userId: input.userId,
      connectionId: input.connectionId,
      issuer: input.issuer,
      discoveryState: input.discoveryState,
      clientInformation: this.row?.clientInformation ?? null,
      clientSecret: this.row?.clientSecret ?? null,
      accessToken: this.row?.accessToken ?? null,
      refreshToken: this.row?.refreshToken ?? null,
      idToken: this.row?.idToken ?? null,
      tokenType: this.row?.tokenType ?? null,
      expiresIn: this.row?.expiresIn ?? null,
      scope: this.row?.scope ?? null,
      lastAuthorizedAt: this.row?.lastAuthorizedAt ?? null,
      createdAt: this.row?.createdAt ?? now,
      updatedAt: now,
    };
    return this.row;
  }

  async update(id: string, userId: string, patch: Partial<McpOauthCredential>): Promise<void> {
    assert.equal(id, this.row?.id);
    assert.equal(userId, this.row?.userId);
    if (!this.row) throw new Error("missing memory credential");
    Object.assign(this.row, patch, { updatedAt: new Date() });
  }

  async createAttempt(input: {
    connectionId: string;
    userId: string;
    stateHash: string;
  }): Promise<McpOauthAuthorizationAttempt> {
    const now = new Date();
    const attempt: McpOauthAuthorizationAttempt = {
      id: `attempt_${this.attempts.size + 1}`,
      ...input,
      codeVerifier: null,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      createdAt: now,
      updatedAt: now,
    };
    this.attempts.set(input.stateHash, attempt);
    return attempt;
  }

  async readAttempt(input: {
    connectionId: string;
    userId: string;
    stateHash: string;
  }): Promise<McpOauthAuthorizationAttempt | undefined> {
    const attempt = this.attempts.get(input.stateHash);
    return attempt?.connectionId === input.connectionId &&
      attempt.userId === input.userId &&
      attempt.expiresAt.getTime() > Date.now()
      ? attempt
      : undefined;
  }

  async saveAttemptCodeVerifier(input: {
    stateHash: string;
    userId: string;
    codeVerifier: McpOauthAuthorizationAttempt["codeVerifier"];
  }): Promise<void> {
    const attempt = this.attempts.get(input.stateHash);
    assert.equal(attempt?.userId, input.userId);
    if (!attempt) throw new Error("missing attempt");
    attempt.codeVerifier = input.codeVerifier;
  }

  async deleteAttempt(stateHash: string, userId: string): Promise<void> {
    const attempt = this.attempts.get(stateHash);
    assert.equal(attempt?.userId, userId);
    this.attempts.delete(stateHash);
  }

  async updateConnectionAuthorization(input: {
    connectionId: string;
    userId: string;
    grantedScopes: string[];
  }): Promise<void> {
    assert.equal(input.connectionId, "conn_test");
    assert.equal(input.userId, "user_test");
    this.grantedScopes = input.grantedScopes;
  }
}

function provider(store: MemoryStore, vault = createCredentialVault(randomBytes(32))) {
  return new McpOAuthProvider({
    connectionId: "conn_test",
    userId: "user_test",
    endpoint: new URL("https://mcp.example.test/mcp"),
    redirectUrl: new URL("https://alfred.example.test/api/integrations/mcp/callback"),
    clientMetadataUrl: "https://alfred.example.test/api/integrations/mcp/client-metadata",
    clientMetadata: {
      redirect_uris: ["https://alfred.example.test/api/integrations/mcp/callback"],
      client_name: "Alfred",
    },
    store,
    vault,
  });
}

const DISCOVERY: OAuthDiscoveryState = {
  authorizationServerUrl: "https://auth.example.test/",
  resourceMetadata: {
    resource: "https://mcp.example.test/mcp",
    authorization_servers: ["https://auth.example.test/"],
  },
  authorizationServerMetadata: {
    issuer: "https://auth.example.test/",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: "https://auth.example.test/token",
    response_types_supported: ["code"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  },
};

function hashState(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("MCP OAuth provider", () => {
  test("persists discovery and isolates client information by issuer", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);

    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveClientInformation(
      {
        client_id: "https://alfred.example.test/api/integrations/mcp/client-metadata",
        issuer: "https://auth.example.test/",
      },
      { issuer: "https://auth.example.test/" },
    );

    assert.equal(
      (
        await oauth.clientInformation({
          issuer: "https://auth.example.test/",
        })
      )?.client_id,
      "https://alfred.example.test/api/integrations/mcp/client-metadata",
    );
    assert.equal(
      await oauth.clientInformation({ issuer: "https://other.example.test/" }),
      undefined,
    );
    assert.deepEqual(await oauth.discoveryState(), DISCOVERY);
  });

  test("retains a rotated refresh token when a token response omits it", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);
    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveTokens(
      {
        access_token: "access-one",
        refresh_token: "refresh-one",
        token_type: "Bearer",
        scope: "read write",
        issuer: "https://auth.example.test/",
      },
      { issuer: "https://auth.example.test/" },
    );
    await oauth.saveTokens(
      {
        access_token: "access-two",
        token_type: "Bearer",
        issuer: "https://auth.example.test/",
      },
      { issuer: "https://auth.example.test/" },
    );

    const tokens = await oauth.tokens({ issuer: "https://auth.example.test/" });
    assert.equal(tokens?.access_token, "access-two");
    assert.equal(tokens?.refresh_token, "refresh-one");
    assert.deepEqual(store.grantedScopes, ["read", "write"]);
  });

  test("passes callback parameters to SDK iss validation before token exchange", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);
    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveClientInformation(
      {
        client_id: "client-id",
        issuer: "https://auth.example.test/",
      },
      { issuer: "https://auth.example.test/" },
    );
    const callbackState = "callback-state";
    await store.createAttempt({
      connectionId: "conn_test",
      userId: "user_test",
      stateHash: hashState(callbackState),
    });
    assert.equal(await oauth.matchesState(callbackState), true);
    await oauth.saveCodeVerifier("verifier");

    await assert.rejects(
      finishMcpOAuth(
        oauth,
        new URL("https://mcp.example.test/mcp"),
        new URLSearchParams({
          code: "must-not-be-redeemed",
          iss: "https://attacker.example.test/",
        }),
      ),
      (error: unknown) =>
        error instanceof IssuerMismatchError && error.kind === "authorization_response",
    );
    assert.equal((await oauth.tokens())?.access_token, undefined);
  });

  test("keeps concurrent authorization attempts isolated by state", async () => {
    const store = new MemoryStore();
    const first = provider(store);
    const second = provider(store);
    await first.saveDiscoveryState(DISCOVERY);
    for (const state of ["state-one", "state-two"]) {
      await store.createAttempt({
        connectionId: "conn_test",
        userId: "user_test",
        stateHash: hashState(state),
      });
    }

    assert.equal(await first.matchesState("state-one"), true);
    assert.equal(await second.matchesState("state-two"), true);
    await first.saveCodeVerifier("verifier-one");
    await second.saveCodeVerifier("verifier-two");

    assert.equal(await first.codeVerifier(), "verifier-one");
    assert.equal(await second.codeVerifier(), "verifier-two");
  });

  test("rejects an expired authorization attempt", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);
    const attempt = await store.createAttempt({
      connectionId: "conn_test",
      userId: "user_test",
      stateHash: hashState("expired-state"),
    });
    attempt.expiresAt = new Date(Date.now() - 1);

    assert.equal(await oauth.matchesState("expired-state"), false);
  });

  test("requires authorization when an expired token cannot refresh", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);
    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveTokens(
      {
        access_token: "expired-access",
        token_type: "Bearer",
        expires_in: 1,
        issuer: "https://auth.example.test/",
      },
      { issuer: "https://auth.example.test/" },
    );
    assert.ok(store.row);
    store.row.lastAuthorizedAt = new Date(Date.now() - 120_000);

    assert.equal(await oauth.authorizationNeedsRefresh(), true);
  });

  test("refreshes a known-expired token before MCP dispatch", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);
    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveClientInformation(
      { client_id: "client-id", issuer: "https://auth.example.test/" },
      { issuer: "https://auth.example.test/" },
    );
    await oauth.saveTokens(
      {
        access_token: "expired-access",
        refresh_token: "refresh-one",
        token_type: "Bearer",
        expires_in: 1,
        issuer: "https://auth.example.test/",
      },
      { issuer: "https://auth.example.test/" },
    );
    assert.ok(store.row);
    store.row.lastAuthorizedAt = new Date(Date.now() - 120_000);
    let tokenRequests = 0;

    await refreshMcpOAuthIfNeeded(oauth, new URL("https://mcp.example.test/mcp"), {
      fetch: async (input) => {
        assert.equal(String(input), "https://auth.example.test/token");
        tokenRequests += 1;
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-two",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    assert.equal(tokenRequests, 1);
    assert.equal((await oauth.tokens())?.access_token, "fresh-access");
  });

  test("aborts OAuth discovery at the configured deadline", async () => {
    const store = new MemoryStore();
    const oauth = provider(store);
    const hangingFetch: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        const fuse = setTimeout(
          () => reject(new Error("OAuth timeout signal was not propagated")),
          100,
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(fuse);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });

    await assert.rejects(
      authorizeMcpOAuth(oauth, new URL("https://mcp.example.test/mcp"), {
        fetch: hangingFetch,
        timeoutMs: 5,
      }),
      (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
    );
  });
});

/**
 * The at-rest column shape of an MCP credential, asserted straight out of the
 * store the provider writes to. The round-trip tests above open again through
 * `open()`, which fails closed on plaintext — so a lone seal→identity mutation
 * is already caught. These assert the stored *value* is an envelope so that a
 * coordinated seal-and-open removal (write raw, read raw) cannot pass while
 * leaving `mcp_oauth_credentials.{client_secret,access_token,refresh_token,
 * id_token}` and `mcp_oauth_authorization_attempts.code_verifier` in plaintext.
 * Tier 2: the MemoryStore stands in for Postgres, so this proves the provider
 * hands the store an envelope, not that the real row is sealed end-to-end.
 */
describe("MCP OAuth credentials are sealed at rest", () => {
  const ISSUER = "https://auth.example.test/";

  test("saveTokens seals every secret column while metadata passes through raw", async () => {
    const store = new MemoryStore();
    const vault = createCredentialVault(randomBytes(32));
    const oauth = provider(store, vault);
    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveTokens(
      {
        access_token: "access-plain",
        refresh_token: "refresh-plain",
        id_token: "id-plain",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read write",
        issuer: ISSUER,
      },
      { issuer: ISSUER },
    );

    assert.ok(store.row);
    const row = store.row;
    for (const [column, plaintext] of [
      ["accessToken", "access-plain"],
      ["refreshToken", "refresh-plain"],
      ["idToken", "id-plain"],
    ] as const) {
      const stored = row[column];
      assert.ok(vault.isSealed(stored), `${column} reached the store unsealed`);
      assert.notEqual(stored, plaintext);
      assert.equal(vault.open(stored), plaintext);
    }
    // Non-secret metadata is stored raw, unchanged.
    assert.equal(row.tokenType, "Bearer");
    assert.equal(row.expiresIn, 3600);
    assert.equal(row.scope, "read write");

    // The owning read path still returns the original plaintext.
    const tokens = await oauth.tokens({ issuer: ISSUER });
    assert.equal(tokens?.access_token, "access-plain");
    assert.equal(tokens?.refresh_token, "refresh-plain");
    assert.equal(tokens?.id_token, "id-plain");
  });

  test("saveClientInformation seals the client secret while the public read returns it", async () => {
    const store = new MemoryStore();
    const vault = createCredentialVault(randomBytes(32));
    const oauth = provider(store, vault);
    await oauth.saveDiscoveryState(DISCOVERY);
    await oauth.saveClientInformation(
      { client_id: "client-id", client_secret: "super-secret", issuer: ISSUER },
      { issuer: ISSUER },
    );

    assert.ok(store.row);
    const stored = store.row.clientSecret;
    assert.ok(vault.isSealed(stored), "client_secret reached the store unsealed");
    assert.notEqual(stored, "super-secret");
    assert.equal(vault.open(stored), "super-secret");

    const info = await oauth.clientInformation({ issuer: ISSUER });
    assert.equal(info?.client_secret, "super-secret");
  });

  test("saveCodeVerifier seals the PKCE verifier while the public read returns it", async () => {
    const store = new MemoryStore();
    const vault = createCredentialVault(randomBytes(32));
    const oauth = provider(store, vault);
    const callbackState = "pkce-state";
    await store.createAttempt({
      connectionId: "conn_test",
      userId: "user_test",
      stateHash: hashState(callbackState),
    });
    assert.equal(await oauth.matchesState(callbackState), true);
    await oauth.saveCodeVerifier("pkce-verifier");

    const attempt = store.attempts.get(hashState(callbackState));
    assert.ok(attempt);
    const stored = attempt.codeVerifier;
    assert.ok(vault.isSealed(stored), "code_verifier reached the store unsealed");
    assert.notEqual(stored, "pkce-verifier");
    assert.equal(vault.open(stored), "pkce-verifier");

    assert.equal(await oauth.codeVerifier(), "pkce-verifier");
  });
});

/**
 * The #934 path: GitHub's authorization server supports neither RFC 7591
 * dynamic registration nor URL-based client ids, so the provider answers
 * `clientInformation` from the ENVIRONMENT and the SDK skips `registerClient`.
 * The environment is canonical — no row ever holds this client — so these tests
 * also pin that nothing is written and that a rotated secret is picked up.
 */
describe("built-in GitHub MCP OAuth client (#934)", () => {
  const CLIENT_ID = "GITHUB_MCP_CLIENT_ID";
  const CLIENT_SECRET = "GITHUB_MCP_CLIENT_SECRET";

  function githubProvider(store: MemoryStore): McpOAuthProvider {
    return new McpOAuthProvider({
      connectionId: "conn_test",
      userId: "user_test",
      endpoint: new URL(GITHUB_MCP_ENDPOINT_HREF),
      redirectUrl: new URL("https://alfred.example.test/api/integrations/mcp/callback"),
      clientMetadata: {
        redirect_uris: ["https://alfred.example.test/api/integrations/mcp/callback"],
        token_endpoint_auth_method: "none",
        client_name: "Alfred",
      },
      store,
      vault: createCredentialVault(randomBytes(32)),
    });
  }

  const GITHUB_DISCOVERY: OAuthDiscoveryState = {
    authorizationServerUrl: GITHUB_MCP_ISSUER,
    authorizationServerMetadata: {
      issuer: GITHUB_MCP_ISSUER,
      authorization_endpoint: "https://github.com/login/oauth/authorize",
      token_endpoint: "https://github.com/login/oauth/access_token",
      response_types_supported: ["code"],
    },
  };

  afterEach(() => {
    delete process.env[CLIENT_ID];
    delete process.env[CLIENT_SECRET];
  });

  test("answers clientInformation from the environment so the SDK skips registration", async () => {
    process.env[CLIENT_ID] = "gh-client-id";
    process.env[CLIENT_SECRET] = "gh-client-secret";
    const store = new MemoryStore();
    const oauth = githubProvider(store);

    const info = await oauth.clientInformation({ issuer: GITHUB_MCP_ISSUER });

    assert.equal(info?.client_id, "gh-client-id");
    assert.equal(info?.client_secret, "gh-client-secret");
    assert.equal(info?.issuer, GITHUB_MCP_ISSUER);
  });

  test("declares the auth method the SDK reads off client information", async () => {
    process.env[CLIENT_ID] = "gh-client-id";
    process.env[CLIENT_SECRET] = "gh-client-secret";
    const oauth = githubProvider(new MemoryStore());
    const info = await oauth.clientInformation({ issuer: GITHUB_MCP_ISSUER });
    assert.ok(info);

    // The SDK picks the method from client INFORMATION, never from the
    // registration metadata, and an empty `supportedMethods` list is what
    // GitHub's metadata document actually yields.
    assert.equal(selectClientAuthMethod(info, []), "client_secret_post");
    assert.equal(oauth.clientMetadata.token_endpoint_auth_method, "none");
  });

  test("the token exchange carries the client secret in the request body", async () => {
    process.env[CLIENT_ID] = "gh-client-id";
    process.env[CLIENT_SECRET] = "gh-client-secret";
    const oauth = githubProvider(new MemoryStore());
    const info = await oauth.clientInformation({ issuer: GITHUB_MCP_ISSUER });
    assert.ok(info);

    let body: URLSearchParams | undefined;
    let authorizationHeader: string | null = null;
    const tokens = await exchangeAuthorization(GITHUB_MCP_ISSUER, {
      metadata: {
        issuer: GITHUB_MCP_ISSUER,
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        token_endpoint: "https://github.com/login/oauth/access_token",
        response_types_supported: ["code"],
      },
      clientInformation: info,
      authorizationCode: "code-123",
      codeVerifier: "verifier-123",
      redirectUri: "https://alfred.example.test/api/integrations/mcp/callback",
      fetchFn: async (_url, init) => {
        body = new URLSearchParams(String(init?.body));
        authorizationHeader = new Headers(init?.headers).get("Authorization");
        return new Response(JSON.stringify({ access_token: "gh-token", token_type: "Bearer" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(tokens.access_token, "gh-token");
    assert.equal(body?.get("client_id"), "gh-client-id");
    assert.equal(body?.get("client_secret"), "gh-client-secret");
    assert.equal(authorizationHeader, null);
  });

  test("saveDiscoveryState never copies the client into the credential row", async () => {
    process.env[CLIENT_ID] = "gh-client-id";
    process.env[CLIENT_SECRET] = "gh-client-secret";
    const store = new MemoryStore();
    const oauth = githubProvider(store);

    await oauth.saveDiscoveryState(GITHUB_DISCOVERY);

    // The row holds discovery only. A durable copy would pin the secret at the
    // value it had on first connect and survive every later rotation.
    assert.equal(store.row?.clientInformation, null);
    assert.equal(store.row?.clientSecret, null);
  });

  test("a rotated secret reaches the next exchange with no reconsent", async () => {
    process.env[CLIENT_ID] = "gh-client-id";
    process.env[CLIENT_SECRET] = "secret-one";
    const store = new MemoryStore();
    const oauth = githubProvider(store);
    await oauth.saveDiscoveryState(GITHUB_DISCOVERY);
    assert.equal(
      (await oauth.clientInformation({ issuer: GITHUB_MCP_ISSUER }))?.client_secret,
      "secret-one",
    );

    process.env[CLIENT_SECRET] = "secret-two";

    assert.equal(
      (await oauth.clientInformation({ issuer: GITHUB_MCP_ISSUER }))?.client_secret,
      "secret-two",
    );
  });

  test("an unconfigured environment leaves the built-in absent", async () => {
    const oauth = githubProvider(new MemoryStore());
    assert.equal(await oauth.clientInformation({ issuer: GITHUB_MCP_ISSUER }), undefined);
  });
});

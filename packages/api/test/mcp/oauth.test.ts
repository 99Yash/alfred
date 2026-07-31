import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCredentialVault } from "@alfred/db/credential-vault";
import type { McpOauthAuthorizationAttempt, McpOauthCredential } from "@alfred/db/schemas";
import { IssuerMismatchError, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { createHash, randomBytes } from "node:crypto";
import {
  authorizeMcpOAuth,
  finishMcpOAuth,
  McpOAuthProvider,
  refreshMcpOAuthIfNeeded,
  type McpOAuthCredentialStore,
} from "../../src/modules/mcp";

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

function provider(store: MemoryStore) {
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
    vault: createCredentialVault(randomBytes(32)),
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

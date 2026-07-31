import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCredentialVault } from "@alfred/db/credential-vault";
import type { McpOauthCredential } from "@alfred/db/schemas";
import { IssuerMismatchError, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { randomBytes } from "node:crypto";
import {
  finishMcpOAuth,
  McpOAuthProvider,
  type McpOAuthCredentialStore,
} from "../../src/modules/mcp";

class MemoryStore implements McpOAuthCredentialStore {
  row: McpOauthCredential | undefined;
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
      codeVerifier: this.row?.codeVerifier ?? null,
      oauthStateHash: this.row?.oauthStateHash ?? null,
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
});

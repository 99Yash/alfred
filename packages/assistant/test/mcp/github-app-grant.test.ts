import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { mcpConnections, mcpOauthCredentials, user } from "@alfred/db/schemas";
import type { Tool } from "@modelcontextprotocol/client";
import { eq, inArray, like } from "drizzle-orm";

import { McpRawClient } from "../../src/connections/mcp/client";
import { McpClientError } from "../../src/connections/mcp/errors";
import {
  adoptGithubAppGrant,
  detachGithubAppGrant,
  type GithubAppUserGrant,
} from "../../src/connections/mcp/github-app-grant";
import {
  McpConnectionManager,
  type McpConnectionReconnectOutcome,
} from "../../src/connections/mcp/manager";
import {
  ensureBuiltInConnection,
  ensureConnection,
  readConnection,
} from "../../src/connections/mcp/persistence";
import type {
  McpNegotiatedServer,
  McpProtocolCallResult,
  McpProtocolClient,
  McpProtocolPage,
} from "../../src/connections/mcp/protocol";
import {
  _setMcpConnectionManagerForTests,
  permissiveMcpEndpointAuthorizerForTests,
} from "../../src/connections/mcp/test-support";
import { dbBackedSkip } from "../support/db-backed";
import { unsealedTestSecret } from "../support/unsealed-secret";

/**
 * DB-backed tests for the GitHub App grant on the GitHub MCP row (ADR-0093 amendments of
 * 2026-11-12 and 2026-11-13). Needs `DATABASE_URL`. Seeds `test-ghgrant-*` users.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-ghgrant-";

const createdUserIds: string[] = [];

const GRANT: GithubAppUserGrant = {
  accessToken: "ghu_test_access",
  refreshToken: "ghr_test_refresh",
  tokenType: "bearer",
  expiresInSeconds: 28_800,
  scopes: [],
};

class FakeProtocol implements McpProtocolClient {
  closeCount = 0;

  async connect(): Promise<McpNegotiatedServer> {
    return {
      protocolEra: "pre_2026_07_28",
      protocolVersion: "2025-11-25",
      mirrorsParamHeaders: false,
      serverName: "fake",
      serverVersion: "1",
      hasTools: true,
      toolsListChanged: true,
    };
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
  async listTools(): Promise<McpProtocolPage> {
    return { tools: [tool("get_me")], ttlMs: 0, cacheScope: "private" };
  }
  async callTool(): Promise<McpProtocolCallResult> {
    return { content: [{ type: "text", text: "ok" }] };
  }
  onToolsChanged(): void {}
  onConnectionUnhealthy(): void {}
}

/** A manager whose `adoptGrant` returns a set outcome, and records the row it got. */
class ScriptedAdoptManager extends McpConnectionManager {
  readonly adoptedConnectionIds: string[] = [];
  readonly #outcome: McpConnectionReconnectOutcome;

  constructor(outcome: McpConnectionReconnectOutcome) {
    super();
    this.#outcome = outcome;
  }

  override async adoptGrant(connectionId: string): Promise<McpConnectionReconnectOutcome> {
    this.adoptedConnectionIds.push(connectionId);

    return this.#outcome;
  }
}

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

/** A credential that holds a grant, selected on the connection. */
async function seedGrant(connectionId: string, userId: string): Promise<string> {
  const [credential] = await db()
    .insert(mcpOauthCredentials)
    .values({
      userId,
      connectionId,
      issuer: "https://github.com/login/oauth",
      accessToken: unsealedTestSecret("access"),
      refreshToken: unsealedTestSecret("refresh"),
      idToken: unsealedTestSecret("id"),
      tokenType: "bearer",
    })
    .returning({ id: mcpOauthCredentials.id });

  assert.ok(credential);
  await db()
    .update(mcpConnections)
    .set({ credentialId: credential.id })
    .where(eq(mcpConnections.id, connectionId));

  return credential.id;
}

async function readTokens(credentialId: string) {
  const [row] = await db()
    .select({
      issuer: mcpOauthCredentials.issuer,
      accessToken: mcpOauthCredentials.accessToken,
      refreshToken: mcpOauthCredentials.refreshToken,
      idToken: mcpOauthCredentials.idToken,
    })
    .from(mcpOauthCredentials)
    .where(eq(mcpOauthCredentials.id, credentialId));

  return row;
}

function managerWith(protocol: FakeProtocol): McpConnectionManager {
  return new McpConnectionManager({
    clientFactory: (connection) =>
      new McpRawClient({
        auth: { mode: "none" },
        connectionId: connection.id,
        endpoint: connection.server,
        endpointAuthorizer: permissiveMcpEndpointAuthorizerForTests(),
        protocolFactory: () => protocol,
      }),
  });
}

describe("GitHub App grant on the GitHub MCP (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  afterEach(() => {
    _setMcpConnectionManagerForTests();
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("adoption returns failed with a message when the GitHub row cannot be created", async () => {
    const manager = new ScriptedAdoptManager({ outcome: "connected" });
    _setMcpConnectionManagerForTests(manager);

    // No user row, so the connection insert fails its foreign key.
    const outcome = await adoptGithubAppGrant({ userId: `${ID_PREFIX}absent`, grant: GRANT });

    assert.equal(outcome.outcome, "failed");
    assert.ok(outcome.message.length > 0);
    assert.deepEqual(manager.adoptedConnectionIds, [], "no row, so nothing to adopt on");
  });

  test("adoption maps each manager outcome for the callback redirect", async () => {
    const userId = await seedUser();

    const cases: Array<{
      readonly adopted: McpConnectionReconnectOutcome;
      readonly expected: { outcome: string; message?: RegExp };
    }> = [
      { adopted: { outcome: "connected" }, expected: { outcome: "connected" } },
      { adopted: { outcome: "auth_required" }, expected: { outcome: "auth_required" } },
      {
        adopted: { outcome: "failed", lastError: "open refused" },
        expected: { outcome: "failed", message: /^open refused$/ },
      },
      { adopted: { outcome: "not_found" }, expected: { outcome: "failed", message: /missing/ } },
    ];

    for (const { adopted, expected } of cases) {
      const manager = new ScriptedAdoptManager(adopted);
      _setMcpConnectionManagerForTests(manager);

      const outcome = await adoptGithubAppGrant({ userId, grant: GRANT });

      assert.equal(outcome.outcome, expected.outcome, adopted.outcome);

      if (expected.message) {
        assert.match(outcome.outcome === "failed" ? outcome.message : "", expected.message);
      }

      const github = await ensureBuiltInConnection(userId, "github");
      assert.deepEqual(manager.adoptedConnectionIds, [github.id]);
    }
  });

  test("detach writes disconnected and clears the tokens of the GitHub row only", async () => {
    const userId = await seedUser();
    const github = await ensureBuiltInConnection(userId, "github");
    const githubCredentialId = await seedGrant(github.id, userId);

    const other = await ensureConnection({
      userId,
      label: "Other MCP",
      instanceKey: "default",
      canonicalResource: `mcp://test/${randomUUID()}`,
      endpoint: new URL("https://mcp.example.test/mcp"),
    });

    const otherCredentialId = await seedGrant(other.id, userId);
    const protocol = new FakeProtocol();
    const manager = managerWith(protocol);
    _setMcpConnectionManagerForTests(manager);
    await manager.openForOwner(github.id);
    assert.equal((await readConnection(github.id))?.status, "ready");

    await detachGithubAppGrant(userId);

    const row = await readConnection(github.id);
    assert.equal(row?.status, "disconnected");
    assert.equal(row.currentCatalogRevisionId, null);
    assert.equal(protocol.closeCount, 1);

    // The registration stays; the grant goes.
    assert.deepEqual(await readTokens(githubCredentialId), {
      issuer: "https://github.com/login/oauth",
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    assert.deepEqual(await readTokens(otherCredentialId), {
      issuer: "https://github.com/login/oauth",
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id",
    });

    // A call or recovery cannot open it again. Only a GitHub connect can.
    await assert.rejects(
      manager.getReadyClient(github.id),
      (error: unknown) => error instanceof McpClientError && error.code === "not_connected",
    );
  });

  test("detach with no GitHub row changes nothing", async () => {
    const userId = await seedUser();

    const other = await ensureConnection({
      userId,
      label: "Other MCP",
      instanceKey: "default",
      canonicalResource: `mcp://test/${randomUUID()}`,
      endpoint: new URL("https://mcp.example.test/mcp"),
    });

    const credentialId = await seedGrant(other.id, userId);
    const before = await readConnection(other.id);

    await detachGithubAppGrant(userId);

    assert.equal((await readConnection(other.id))?.status, before?.status);
    assert.equal((await readTokens(credentialId))?.accessToken, "access");
  });
});

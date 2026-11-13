import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import type { IntegrationAvailabilitySnapshot } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { registerTools } from "@alfred/assistant/tool-runtime";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";
import {
  integrationOfMcpConnection,
  mcpScopeAdmits,
  mcpServerIdsAdmittedBy,
} from "../../src/connections/mcp/allowlist";
import {
  GITHUB_MCP_ENDPOINT_HREF,
  LINEAR_MCP_ENDPOINT_HREF,
} from "../../src/connections/mcp/constants";
import { ensureConnection, publishCatalogRevision } from "../../src/connections/mcp/persistence";
import { buildConnectedSummaryFromAvailability } from "../../src/execution/connected-summary";
import { mcpTools } from "../../src/tool-runtime/internal/tools/mcp";
import { dbBackedSkip } from "../support/db-backed";

/**
 * The MCP scope that a run's integration allowlist sets. Discovery, the connected summary, and the
 * broker read the same value. A built-in server belongs to the integration of its pinned endpoint.
 * Needs `DATABASE_URL`.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-mcpscope-";

const createdUserIds: string[] = [];

const EMPTY_SNAPSHOT: IntegrationAvailabilitySnapshot = {
  integrations: new Map(),
  providers: new Map(),
  passthroughEnabled: new Map(),
};

type SeededConnection = { connectionId: string; serverId: string };

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

/** A connection with a one-tool catalog, so the connected summary lists it. */
async function seedConnection(
  userId: string,
  input: { label: string; instanceKey: string; canonicalResource: string; endpointHref: string },
): Promise<SeededConnection> {
  const conn = await ensureConnection({
    userId,
    label: input.label,
    instanceKey: input.instanceKey,
    canonicalResource: input.canonicalResource,
    endpoint: new URL(input.endpointHref),
  });

  await publishCatalogRevision({
    connectionId: conn.id,
    revisionHash: `sha256:${randomUUID().replace(/-/g, "")}`,
    descriptors: [{ name: "search", inputSchema: { type: "object" } }],
  });

  return { connectionId: conn.id, serverId: conn.serverId };
}

/** The GitHub and Linear built-ins, and one user-added server. */
async function seedThreeServers(userId: string) {
  const github = await seedConnection(userId, {
    label: "GitHub",
    instanceKey: "github",
    canonicalResource: GITHUB_MCP_ENDPOINT_HREF,
    endpointHref: GITHUB_MCP_ENDPOINT_HREF,
  });

  const linear = await seedConnection(userId, {
    label: "Linear",
    instanceKey: "linear",
    canonicalResource: LINEAR_MCP_ENDPOINT_HREF,
    endpointHref: LINEAR_MCP_ENDPOINT_HREF,
  });

  const userAdded = await seedConnection(userId, {
    label: "User MCP",
    instanceKey: "default",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpointHref: "https://mcp.example.test/mcp",
  });

  return { github, linear, userAdded };
}

describe("MCP run scope (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  beforeEach(() => {
    resetToolFixtures();
    registerTools(mcpTools);
  });

  afterEach(resetToolFixtures);

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("an allowlist admits only the built-in servers of its integrations", async () => {
    const userId = await seedUser();
    const { github, linear, userAdded } = await seedThreeServers(userId);

    assert.deepEqual(await mcpServerIdsAdmittedBy(userId, ["github"]), [github.serverId]);

    // `gmail` has no built-in MCP server, so the scope is empty and admits no server.
    const none = await mcpServerIdsAdmittedBy(userId, ["gmail"]);
    assert.deepEqual(none, []);

    for (const { serverId } of [github, linear, userAdded]) {
      assert.equal(mcpScopeAdmits(none, serverId), false);
    }
  });

  test("an empty or absent allowlist sets no scope", async () => {
    const userId = await seedUser();
    const { github, linear, userAdded } = await seedThreeServers(userId);

    assert.equal(await mcpServerIdsAdmittedBy(userId, []), null);
    assert.equal(await mcpServerIdsAdmittedBy(userId, undefined), null);

    for (const { serverId } of [github, linear, userAdded]) {
      assert.equal(mcpScopeAdmits(null, serverId), true);
    }
  });

  test("a built-in connection names its integration, and a user-added one names none", async () => {
    const userId = await seedUser();
    const { github, linear, userAdded } = await seedThreeServers(userId);

    assert.equal(await integrationOfMcpConnection(userId, github.connectionId), "github");
    assert.equal(await integrationOfMcpConnection(userId, linear.connectionId), "linear");
    assert.equal(await integrationOfMcpConnection(userId, userAdded.connectionId), null);
    assert.equal(await integrationOfMcpConnection(userId, "mcpc_missing"), null);
  });

  test("the connected summary lists only the MCP connections in the run scope", async () => {
    const userId = await seedUser();
    const { github, linear, userAdded } = await seedThreeServers(userId);
    const context = { caller: "boss", interaction: "background" } as const;

    const scoped = await buildConnectedSummaryFromAvailability(
      userId,
      EMPTY_SNAPSHOT,
      ["github"],
      context,
    );

    assert.match(scoped, new RegExp(`connectionId ${github.connectionId}\\b`));
    assert.doesNotMatch(scoped, new RegExp(`connectionId ${linear.connectionId}\\b`));
    assert.doesNotMatch(scoped, new RegExp(`connectionId ${userAdded.connectionId}\\b`));

    const unscoped = await buildConnectedSummaryFromAvailability(
      userId,
      EMPTY_SNAPSHOT,
      [],
      context,
    );

    for (const { connectionId } of [github, linear, userAdded]) {
      assert.match(unscoped, new RegExp(`connectionId ${connectionId}\\b`));
    }
  });
});

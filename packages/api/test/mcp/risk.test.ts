import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import type { ToolRiskTier } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import {
  insertConnection,
  publishCatalogRevision,
  upsertToolPolicy,
} from "../../src/modules/mcp/persistence";
import { MCP_CALL_RISK_FLOOR, resolveMcpCallRiskTier } from "../../src/modules/mcp/risk";

/**
 * DB-backed tests for the `mcp.call` gate-side effective-risk resolver (#541
 * Part 3). They prove the reviewed per-descriptor downgrade applies ONLY when it
 * binds to the exact tool the model selected on the connection's current catalog,
 * and that every uncertainty falls back to the conservative `high` floor.
 *
 * Opt-in on `DATABASE_URL` (mirrors the other MCP tests); seeds throwaway
 * `test-mcprisk-*` users and cascades everything away on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-mcprisk-";
const createdUserIds: string[] = [];

const REVISION = "sha256:catrev1";
const REMOTE = "search_issues";
const DESC_HASH = "sha256:desc_search_issues";

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedConnection(userId: string): Promise<string> {
  const conn = await insertConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpointUrl: "https://example.test/mcp",
    endpointOrigin: "https://example.test",
  });
  return conn.id;
}

/** Publish a one-tool catalog revision and advance the connection pointer to it. */
async function seedRevision(connectionId: string): Promise<void> {
  await publishCatalogRevision({
    connectionId,
    revisionHash: REVISION,
    descriptors: [{ name: REMOTE }],
    descriptorHashes: { [REMOTE]: DESC_HASH },
    toolCount: 1,
  });
}

describe("resolveMcpCallRiskTier (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("reviewed downgrade on the exact descriptor lowers the tier", async () => {
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    await seedRevision(connectionId);
    await upsertToolPolicy({
      userId,
      connectionId,
      remoteName: REMOTE,
      descriptorHash: DESC_HASH,
      riskTier: "low",
      effectClass: "read",
      retryContract: "safe",
    });

    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: REVISION,
    });
    assert.equal(tier, "low");
  });

  test("no reviewed policy → stays at the high floor", async () => {
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    await seedRevision(connectionId);

    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: REVISION,
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });

  test("a connection with no current revision pointer stays at the floor", async () => {
    // A connection that has never published a catalog (or lost its pointer) has
    // no revision to bind a descriptor against, so the downgrade cannot apply.
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    // NB: no seedRevision — the connection's currentCatalogRevisionId is null.

    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: REVISION,
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });

  test("a stale catalog revision re-gates at the floor even with a downgrade", async () => {
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    await seedRevision(connectionId);
    await upsertToolPolicy({
      userId,
      connectionId,
      remoteName: REMOTE,
      descriptorHash: DESC_HASH,
      riskTier: "low",
      effectClass: "read",
      retryContract: "safe",
    });

    // The model echoes a revision that is NOT the connection's current one.
    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: "sha256:some_old_revision",
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });

  test("descriptor drift (downgrade bound to a different hash) re-gates", async () => {
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    await seedRevision(connectionId);
    // The user reviewed a PRIOR descriptor of this tool; the live one differs.
    await upsertToolPolicy({
      userId,
      connectionId,
      remoteName: REMOTE,
      descriptorHash: "sha256:desc_from_before_drift",
      riskTier: "low",
      effectClass: "read",
      retryContract: "safe",
    });

    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: REVISION,
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });

  test("a connection owned by another user is never downgraded", async () => {
    const ownerId = await seedUser();
    const otherId = await seedUser();
    const connectionId = await seedConnection(ownerId);
    await seedRevision(connectionId);
    await upsertToolPolicy({
      userId: ownerId,
      connectionId,
      remoteName: REMOTE,
      descriptorHash: DESC_HASH,
      riskTier: "low",
      effectClass: "read",
      retryContract: "safe",
    });

    const tier = await resolveMcpCallRiskTier({
      userId: otherId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: REVISION,
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });

  test("a corrupt persisted tier (out of enum) re-gates to the floor", async () => {
    // The persisted `riskTier` is a `$type<ToolRiskTier>()` cast over `text`, not
    // a validated value. If a bad write ever lands an out-of-enum string, the
    // resolver must treat it as unknown and re-gate — never silently un-gate a
    // high-floor call because an unrecognized string isn't literally "high".
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    await seedRevision(connectionId);
    await upsertToolPolicy({
      userId,
      connectionId,
      remoteName: REMOTE,
      descriptorHash: DESC_HASH,
      // Deliberately bypass the type to simulate a corrupt persisted row.
      riskTier: "totally_bogus" as ToolRiskTier,
      effectClass: "read",
      retryContract: "safe",
    });

    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: REMOTE,
      catalogRevision: REVISION,
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });

  test("an unknown remote tool falls back to the floor", async () => {
    const userId = await seedUser();
    const connectionId = await seedConnection(userId);
    await seedRevision(connectionId);

    const tier = await resolveMcpCallRiskTier({
      userId,
      connectionId,
      remoteName: "not_in_catalog",
      catalogRevision: REVISION,
    });
    assert.equal(tier, MCP_CALL_RISK_FLOOR);
  });
});

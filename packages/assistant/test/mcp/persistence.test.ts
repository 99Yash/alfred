import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  actionStagings,
  agentRuns,
  mcpConnections,
  mcpInvocation,
  mcpOauthCredentials,
  mcpServers,
  user,
} from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import {
  compareAndSetCatalogRevision,
  createNamedConnection,
  ensureBuiltInConnection,
  insertCatalogRevision,
  publishCatalogRevision,
  readConnection,
  readCurrentRevision,
  readRevisionByHash,
  updateConnection,
} from "../../src/connections/mcp/persistence";
import {
  findUnresolvedBarrier,
  insertInvocation,
  reconcileInflightInvocations,
  readToolPolicy,
  resolveMcpToolIdentity,
  updateInvocation,
  upsertToolPolicy,
} from "../../src/tool-runtime/mcp/invocations";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed tests for the MCP persistence layer (PRD #540). They exercise the
 * atomic operations the broker rests on — the catalog-revision publish
 * (idempotent insert + pointer advance) and the ledger barrier reservation —
 * plus the boot reconcile sweep. Explicit successor behavior lives in
 * recovery.test.ts, where both durable barriers can be asserted together. Pure
 * row access is covered incidentally by the fixtures.
 *
 * Opt-in on `DATABASE_URL` (mirrors dispatch/staging.test.ts): seeds throwaway
 * `test-mcp-*` users and cascades everything away on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-mcp-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  await db()
    .insert(agentRuns)
    .values({
      id: `run_${randomUUID().slice(0, 12)}`,
      userId,
      workflowSlug: "chat",
      currentStep: "dispatch-tools",
    });
  return userId;
}

/** Mint a throwaway staging row so an `mcp_invocation` can satisfy its FK + 1:1 index. */
async function seedStaging(userId: string): Promise<string> {
  const [run] = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId))
    .limit(1);
  assert.ok(run, "seed run missing");
  const stagingId = `stg_${randomUUID().slice(0, 12)}`;
  const toolCallId = `tc_${randomUUID().slice(0, 8)}`;
  await db()
    .insert(actionStagings)
    .values({
      id: stagingId,
      userId,
      runId: run.id,
      stepId: "dispatch-tools",
      toolCallId,
      toolName: "mcp.call",
      integration: "mcp",
      riskTier: "high",
      proposedInput: {},
      proposedInputHash: randomUUID(),
      // #559a: the ledger's NOT NULL effect identity and canonical request hash.
      effectKey: `eff:${run.id}:${toolCallId}`,
      attemptKey: `eff:${run.id}:${toolCallId}:1`,
      requestHash: `req_seed_${randomUUID()}`,
      requiresApproval: true,
    });
  return stagingId;
}

async function seedConnection(userId: string): Promise<string> {
  const conn = await createNamedConnection({
    userId,
    label: "Test MCP",
    canonicalResource: `mcp://test/${randomUUID()}`,
    endpoint: new URL("https://example.test/mcp"),
  });
  return conn.id;
}

async function selectCredentialForTest(connectionId: string, credentialId: string): Promise<void> {
  await db()
    .update(mcpConnections)
    .set({ credentialId })
    .where(eq(mcpConnections.id, connectionId));
}

describe("mcp persistence (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("connection insert/read/update roundtrip", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);

    const read = await readConnection(connId);
    assert.equal(read?.status, "disconnected");
    assert.deepEqual(read?.grantedScopes, []);

    const updated = await updateConnection(connId, { status: "ready", lastError: null });
    assert.equal(updated?.status, "ready");
  });

  test("named connection instances share one server and keep separate state", async () => {
    const userId = await seedUser();
    const canonicalResource = `mcp://test/${randomUUID()}`;
    const endpoint = new URL("https://shared.example.test/mcp");

    const personal = await createNamedConnection({
      userId,
      label: "Personal",
      canonicalResource,
      endpoint,
    });
    const work = await createNamedConnection({
      userId,
      label: "Work",
      canonicalResource,
      endpoint,
    });

    assert.notEqual(personal.id, work.id);
    assert.equal(personal.serverId, work.serverId);
    assert.deepEqual(personal.server, work.server);

    const revision = await publishCatalogRevision({
      connectionId: personal.id,
      revisionHash: "sha256:personal",
      descriptors: [{ name: "personal_tool" }],
      descriptorHashes: { personal_tool: "sha256:personal_tool" },
      toolCount: 1,
    });
    const [personalCredential, workCredential] = await db()
      .insert(mcpOauthCredentials)
      .values([
        { userId, connectionId: personal.id, issuer: "https://auth.personal.example.test" },
        { userId, connectionId: work.id, issuer: "https://auth.work.example.test" },
      ])
      .returning();
    assert.ok(personalCredential);
    assert.ok(workCredential);
    await selectCredentialForTest(personal.id, personalCredential.id);
    await updateConnection(personal.id, { status: "ready" });
    await selectCredentialForTest(work.id, workCredential.id);

    await updateConnection(personal.id, { label: "Renamed personal" });
    const renamed = await readConnection(personal.id);
    const unchangedWork = await readConnection(work.id);

    assert.ok(renamed);
    assert.equal(renamed.id, personal.id);
    assert.equal(renamed.label, "Renamed personal");
    assert.equal(renamed.status, "ready");
    assert.equal(renamed.credentialId, personalCredential.id);
    assert.equal(renamed.currentCatalogRevisionId, revision.id);
    assert.equal(unchangedWork?.label, "Work");
    assert.equal(unchangedWork?.credentialId, workCredential.id);
    assert.equal(unchangedWork?.currentCatalogRevisionId, null);
  });

  test("a same-owner connection cannot select a sibling OAuth credential", async () => {
    const userId = await seedUser();
    const personalId = await seedConnection(userId);
    const workId = await seedConnection(userId);
    const [workCredential] = await db()
      .insert(mcpOauthCredentials)
      .values({
        userId,
        connectionId: workId,
        issuer: "https://auth.work.example.test",
      })
      .returning();
    assert.ok(workCredential);

    await assert.rejects(
      db()
        .update(mcpConnections)
        .set({ credentialId: workCredential.id })
        .where(eq(mcpConnections.id, personalId)),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.includes("mcp_connections_credential_connection_fk"),
    );
    assert.equal((await readConnection(personalId))?.credentialId, null);
  });

  test("a connection cannot refer to another owner's server", async () => {
    const ownerId = await seedUser();
    const otherUserId = await seedUser();
    const owned = await createNamedConnection({
      userId: ownerId,
      label: "Owned server",
      canonicalResource: `mcp://test/${randomUUID()}`,
      endpoint: new URL("https://owned.example.test/mcp"),
    });

    await assert.rejects(
      db().insert(mcpConnections).values({
        userId: otherUserId,
        serverId: owned.serverId,
        instanceKey: "cross-owner",
        label: "Invalid",
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.includes("mcp_connections_server_owner_fk"),
    );
  });

  test("a server definition cannot be silently retargeted", async () => {
    const userId = await seedUser();
    const canonicalResource = `mcp://test/${randomUUID()}`;
    await createNamedConnection({
      userId,
      label: "Original",
      canonicalResource,
      endpoint: new URL("https://one.example.test/mcp"),
    });

    await assert.rejects(
      createNamedConnection({
        userId,
        label: "Retarget",
        canonicalResource,
        endpoint: new URL("https://two.example.test/mcp"),
      }),
      /already uses endpoint/,
    );
  });

  test("the closed GitHub slot reuses its identity without resetting account state", async () => {
    const userId = await seedUser();
    const first = await ensureBuiltInConnection(userId, "github");
    await updateConnection(first.id, {
      status: "ready",
      lastError: "preserved",
      grantedScopes: ["repo"],
    });

    const replay = await ensureBuiltInConnection(userId, "github");

    assert.equal(replay.id, first.id);
    assert.equal(replay.instanceKey, "default");
    assert.equal(replay.status, "ready");
    assert.equal(replay.lastError, "preserved");
    assert.deepEqual(replay.grantedScopes, ["repo"]);
  });

  test("concurrent first use reuses the GitHub row backfilled by migration 0108", async () => {
    const userId = await seedUser();
    const migratedConnectionId = `mcpc_migrated_${randomUUID()}`;
    const endpoint = new URL("https://api.githubcopilot.com/mcp");
    await db().insert(mcpServers).values({
      id: migratedConnectionId,
      userId,
      canonicalResource: endpoint.href,
      endpointUrl: endpoint.href,
      endpointOrigin: endpoint.origin,
    });
    await db()
      .insert(mcpConnections)
      .values({
        id: migratedConnectionId,
        userId,
        serverId: migratedConnectionId,
        instanceKey: "default",
        label: "GitHub MCP",
        authServerIdentity: "oauth:legacy",
        status: "ready",
        grantedScopes: ["repo"],
        lastError: "legacy-state",
      });
    const [credential] = await db()
      .insert(mcpOauthCredentials)
      .values({
        userId,
        connectionId: migratedConnectionId,
        issuer: "https://github.com/login/oauth",
      })
      .returning();
    assert.ok(credential);
    await selectCredentialForTest(migratedConnectionId, credential.id);
    const revision = await publishCatalogRevision({
      connectionId: migratedConnectionId,
      revisionHash: "sha256:migrated-github",
      descriptors: [{ name: "search_repositories" }],
      descriptorHashes: { search_repositories: "sha256:migrated-search" },
      toolCount: 1,
    });
    const policy = await upsertToolPolicy({
      userId,
      connectionId: migratedConnectionId,
      remoteName: "search_repositories",
      descriptorHash: "sha256:migrated-search",
      riskTier: "low",
      effectClass: "read",
      retryContract: "never",
    });
    const invocation = await insertInvocation({
      userId,
      connectionId: migratedConnectionId,
      remoteName: "search_repositories",
      argsHash: "sha256:migrated-args",
      stagingId: await seedStaging(userId),
      effectClass: "read",
    });
    assert.ok(invocation.ok);

    const [first, second] = await Promise.all([
      ensureBuiltInConnection(userId, "github"),
      ensureBuiltInConnection(userId, "github"),
    ]);

    assert.equal(first.id, migratedConnectionId);
    assert.equal(second.id, migratedConnectionId);
    assert.equal(first.instanceKey, "default");
    assert.equal(first.credentialId, credential.id);
    assert.equal(first.authServerIdentity, "oauth:legacy");
    assert.equal(first.currentCatalogRevisionId, revision.id);
    assert.equal(first.status, "ready");
    assert.equal(first.lastError, "legacy-state");
    assert.deepEqual(first.grantedScopes, ["repo"]);
    assert.equal(
      (await readToolPolicy(migratedConnectionId, "search_repositories", "sha256:migrated-search"))
        ?.id,
      policy.id,
    );
    const [preservedInvocation] = await db()
      .select({ id: mcpInvocation.id, connectionId: mcpInvocation.connectionId })
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, invocation.invocation.id));
    assert.deepEqual(preservedInvocation, {
      id: invocation.invocation.id,
      connectionId: migratedConnectionId,
    });
    const rows = await db()
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(eq(mcpConnections.userId, userId));
    assert.deepEqual(rows, [{ id: migratedConnectionId }]);
  });

  test("publishCatalogRevision is idempotent and advances the pointer", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);

    const revA = await publishCatalogRevision({
      connectionId: connId,
      revisionHash: "sha256:aaa",
      descriptors: [{ name: "tool_a" }],
      descriptorHashes: { tool_a: "sha256:h_a" },
      toolCount: 1,
    });
    // Pointer advanced to the new revision.
    assert.equal((await readConnection(connId))?.currentCatalogRevisionId, revA.id);
    assert.equal((await readCurrentRevision(connId))?.id, revA.id);

    // Re-publishing the SAME hash returns the same row — no duplicate.
    const revAAgain = await publishCatalogRevision({
      connectionId: connId,
      revisionHash: "sha256:aaa",
      descriptors: [{ name: "tool_a" }],
      descriptorHashes: { tool_a: "sha256:h_a" },
      toolCount: 1,
    });
    assert.equal(revAAgain.id, revA.id);

    // A NEW hash mints a new revision and moves the pointer.
    const revB = await publishCatalogRevision({
      connectionId: connId,
      revisionHash: "sha256:bbb",
      descriptors: [{ name: "tool_a" }, { name: "tool_b" }],
      descriptorHashes: { tool_a: "sha256:h_a", tool_b: "sha256:h_b" },
      toolCount: 2,
    });
    assert.notEqual(revB.id, revA.id);
    assert.equal((await readCurrentRevision(connId))?.id, revB.id);
    // The old revision is still readable (append-only history).
    assert.ok(await readRevisionByHash(connId, "sha256:aaa"));
  });

  test("catalog pointer compare-and-swap rejects a stale publisher", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const revisionA = await insertCatalogRevision({
      connectionId: connId,
      revisionHash: "sha256:cas-a",
      descriptors: [{ name: "tool_a" }],
      descriptorHashes: { tool_a: "sha256:h_a" },
      toolCount: 1,
    });
    const revisionB = await insertCatalogRevision({
      connectionId: connId,
      revisionHash: "sha256:cas-b",
      descriptors: [{ name: "tool_b" }],
      descriptorHashes: { tool_b: "sha256:h_b" },
      toolCount: 1,
    });

    const winner = await compareAndSetCatalogRevision({
      connectionId: connId,
      expectedCurrentRevisionId: null,
      nextRevisionId: revisionA.id,
      patch: { status: "ready" },
    });
    assert.equal(winner?.currentCatalogRevisionId, revisionA.id);

    const stale = await compareAndSetCatalogRevision({
      connectionId: connId,
      expectedCurrentRevisionId: null,
      nextRevisionId: revisionB.id,
      patch: { status: "ready" },
    });
    assert.equal(stale, undefined);
    assert.equal((await readConnection(connId))?.currentCatalogRevisionId, revisionA.id);
  });

  test("tool policy upsert then update-on-conflict", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);

    await upsertToolPolicy({
      userId,
      connectionId: connId,
      remoteName: "create_issue",
      descriptorHash: "sha256:desc1",
      riskTier: "high",
      effectClass: "write",
      retryContract: "never",
    });
    let policy = await readToolPolicy(connId, "create_issue", "sha256:desc1");
    assert.equal(policy?.riskTier, "high");

    // Same key, reviewed down to low — conflict updates in place.
    await upsertToolPolicy({
      userId,
      connectionId: connId,
      remoteName: "create_issue",
      descriptorHash: "sha256:desc1",
      riskTier: "low",
      effectClass: "write",
      retryContract: "never",
      policyRevision: 2,
    });
    policy = await readToolPolicy(connId, "create_issue", "sha256:desc1");
    assert.equal(policy?.riskTier, "low");
    assert.equal(policy?.policyRevision, 2);

    // A different descriptor hash is a MISS (drift → no downgrade reused).
    assert.equal(await readToolPolicy(connId, "create_issue", "sha256:DRIFT"), undefined);
  });

  test("tool identity resolves owner, current revision, descriptor, and policy together", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const revision = await publishCatalogRevision({
      connectionId: connId,
      revisionHash: "sha256:catalog",
      descriptors: [{ name: "search" }],
      descriptorHashes: { search: "sha256:search" },
      toolCount: 1,
    });
    const policy = await upsertToolPolicy({
      userId,
      connectionId: connId,
      remoteName: "search",
      descriptorHash: "sha256:search",
      riskTier: "low",
      effectClass: "read",
      retryContract: "never",
    });

    const identity = await resolveMcpToolIdentity({
      userId,
      connectionId: connId,
      remoteName: "search",
      catalogRevision: "sha256:catalog",
    });
    assert.equal(identity.status, "resolved");
    if (identity.status !== "resolved") return;
    assert.equal(identity.connection.id, connId);
    assert.equal(identity.connection.currentCatalogRevisionId, revision.id);
    assert.equal(identity.descriptorHash, "sha256:search");
    assert.equal(identity.policy?.id, policy.id);

    const stale = await resolveMcpToolIdentity({
      userId,
      connectionId: connId,
      remoteName: "search",
      catalogRevision: "sha256:stale",
    });
    assert.equal(stale.status, "unresolved");
    assert.equal(stale.connection?.id, connId, "an owned connection row remains reusable");

    const otherUserId = await seedUser();
    const foreign = await resolveMcpToolIdentity({
      userId: otherUserId,
      connectionId: connId,
      remoteName: "search",
      catalogRevision: "sha256:catalog",
    });
    assert.deepEqual(foreign, { status: "unresolved", connection: undefined });
  });

  test("ledger barrier blocks an identical unresolved proposal", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const barrierKey = {
      userId,
      connectionId: connId,
      remoteName: "create_issue",
      argsHash: "sha256:args1",
    };

    const first = await insertInvocation({
      ...barrierKey,
      stagingId: await seedStaging(userId),
      effectClass: "write",
    });
    assert.equal(first.ok, true);

    // A second, distinct staging with the SAME barrier key is rejected.
    const second = await insertInvocation({
      ...barrierKey,
      stagingId: await seedStaging(userId),
      effectClass: "write",
    });
    assert.deepEqual(second, { ok: false, reason: "barrier" });

    // The broker can read WHY it is blocked.
    const blocking = await findUnresolvedBarrier(barrierKey);
    assert.ok(first.ok && blocking?.id === first.invocation.id);

    // Resolving the prior frees the barrier — an identical insert now succeeds.
    assert.ok(first.ok);
    await updateInvocation(first.invocation.id, {
      resolvedAt: new Date(),
      resolutionReason: "succeeded",
    });
    const third = await insertInvocation({
      ...barrierKey,
      stagingId: await seedStaging(userId),
      effectClass: "write",
    });
    assert.equal(third.ok, true);
  });

  test("duplicate staging id is distinguished from a barrier collision", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const stagingId = await seedStaging(userId);

    const first = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "t",
      argsHash: "sha256:x",
      stagingId,
      effectClass: "read",
    });
    assert.equal(first.ok, true);

    // Same staging id, different barrier key → the 1:1 staging index fires.
    const dup = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "t",
      argsHash: "sha256:DIFFERENT",
      stagingId,
      effectClass: "read",
    });
    assert.deepEqual(dup, { ok: false, reason: "duplicate_staging" });
  });

  test("reconcile sweeps prepared, read, and effectful in-flight rows", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);

    const prepared = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "a",
      argsHash: "sha256:1",
      stagingId: await seedStaging(userId),
      effectClass: "write",
      attemptLifecycle: "prepared",
    });
    const readInflight = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "b",
      argsHash: "sha256:2",
      stagingId: await seedStaging(userId),
      effectClass: "read",
      attemptLifecycle: "delivery_possible",
    });
    const writeStagingId = await seedStaging(userId);
    const writeInflight = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "c",
      argsHash: "sha256:3",
      stagingId: writeStagingId,
      effectClass: "write",
      attemptLifecycle: "delivery_possible",
    });
    assert.ok(prepared.ok && readInflight.ok && writeInflight.ok);

    const summary = await reconcileInflightInvocations(userId);
    assert.equal(summary.abandoned, 1);
    assert.equal(summary.resolvedReads, 1);
    assert.equal(summary.markedUnknown, 1);
    assert.equal(summary.alignedStagingBarriers, 1);

    // prepared + read are resolved; the effectful write stays BLOCKED (unresolved).
    const rows = await db()
      .select()
      .from(mcpInvocation)
      .where(inArray(mcpInvocation.id, [prepared.invocation.id, writeInflight.invocation.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.ok(byId.get(prepared.invocation.id)?.resolvedAt);
    const write = byId.get(writeInflight.invocation.id);
    assert.equal(write?.resolvedAt, null);
    assert.equal(write?.effectOutcome, "unknown");
    assert.equal(write?.retryDisposition, "blocked");
    const [writeStaging] = await db()
      .select({ outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(eq(actionStagings.id, writeStagingId));
    assert.equal(writeStaging?.outcome, "unknown");
  });

  test("a crash after delivery_possible blocks an identical fresh proposal on resume", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const key = {
      userId,
      connectionId: connId,
      remoteName: "charge_card",
      argsHash: "sha256:pay-crash",
    };

    // A process died right after crossing the delivery boundary: a
    // `delivery_possible` write row with no outcome yet.
    const crashedStagingId = await seedStaging(userId);
    const crashed = await insertInvocation({
      ...key,
      stagingId: crashedStagingId,
      effectClass: "write",
      attemptLifecycle: "delivery_possible",
    });
    assert.ok(crashed.ok);

    // Boot reconcile normalizes the possibly-delivered write to unknown/blocked
    // WITHOUT resolving it — the barrier must survive the crash.
    await reconcileInflightInvocations(userId);
    const [recovered] = await db()
      .select()
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, crashed.invocation.id));
    assert.equal(recovered?.effectOutcome, "unknown");
    assert.equal(recovered?.retryDisposition, "blocked");
    assert.equal(recovered?.resolvedAt, null);
    const [recoveredStaging] = await db()
      .select({ outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(eq(actionStagings.id, crashedStagingId));
    assert.equal(recoveredStaging?.outcome, "unknown");

    // On resume a fresh `tool_call_id` (new staging) proposing the identical call
    // is refused by the durable barrier — it cannot bypass the recovered unknown.
    const resumed = await insertInvocation({
      ...key,
      stagingId: await seedStaging(userId),
      effectClass: "write",
    });
    assert.deepEqual(resumed, { ok: false, reason: "barrier" });
  });

  test("boot repairs an unknown invocation whose staging barrier stayed dispatching", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const stagingId = await seedStaging(userId);
    await db()
      .update(actionStagings)
      .set({ status: "approved", outcome: "dispatching" })
      .where(eq(actionStagings.id, stagingId));
    const crashed = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "send_invoice",
      argsHash: "sha256:post-broker-crash",
      stagingId,
      effectClass: "write",
      attemptLifecycle: "delivery_possible",
      effectOutcome: "unknown",
      retryDisposition: "blocked",
      deliveryPossibleAt: new Date(),
    });
    assert.ok(crashed.ok);

    const firstBoot = await reconcileInflightInvocations(userId);
    assert.equal(firstBoot.markedUnknown, 0, "the broker had already recorded ambiguity");
    assert.equal(firstBoot.alignedStagingBarriers, 1);
    const [staging] = await db()
      .select({ status: actionStagings.status, outcome: actionStagings.outcome })
      .from(actionStagings)
      .where(eq(actionStagings.id, stagingId));
    assert.deepEqual(staging, { status: "executed", outcome: "unknown" });

    const secondBoot = await reconcileInflightInvocations(userId);
    assert.equal(secondBoot.alignedStagingBarriers, 0, "the repair is idempotent");
    const [invocation] = await db()
      .select({ resolvedAt: mcpInvocation.resolvedAt })
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, crashed.invocation.id));
    assert.equal(invocation?.resolvedAt, null, "repair keeps the no-replay barrier unresolved");
  });

  test("a connection cannot point at another connection's catalog revision", async () => {
    const userId = await seedUser();
    const connA = await seedConnection(userId);
    const connB = await seedConnection(userId);

    // Publish a revision that belongs to connection B.
    const revB = await publishCatalogRevision({
      connectionId: connB,
      revisionHash: "sha256:for-b",
      descriptors: [{ name: "b_tool" }],
      descriptorHashes: { b_tool: "sha256:hb" },
      toolCount: 1,
    });

    // Pointing A's current-revision at B's revision violates the composite FK
    // ((connectionId, id) must match), so the write is rejected outright
    // (issue #540 clarification #6). Drizzle wraps the pg error, so the
    // constraint text rides on `.cause`.
    await assert.rejects(
      updateConnection(connA, { currentCatalogRevisionId: revB.id }),
      (err: unknown) => {
        const cause = err instanceof Error ? err.cause : undefined;
        const text = `${String(err)} ${cause instanceof Error ? cause.message : String(cause)}`;
        return /foreign key|violates|constraint/i.test(text);
      },
    );
  });
});

/**
 * The ONE branch of `insertInvocation` no live database can reach, and the one the
 * move changed. The barrier classification used to run on a hand-rolled 23505
 * narrowing whose return distinguished three cases by `undefined` vs `""`; it now
 * runs on `@alfred/db`'s canonical `isUniqueViolation` + `uniqueViolationConstraint`
 * pair. Two cases are already pinned above against real indexes: a named barrier
 * collision and a named `mcp_invocation_staging_idx` collision. The third — a 23505
 * whose `constraint` the driver did NOT report — must still default to the barrier,
 * because reading only the constraint name would collapse it into "not a unique
 * violation" and rethrow, turning a blocked ambiguous write into a 500.
 *
 * Postgres always names the index it violated, so this is reachable only with an
 * injected runner. That is also what makes it worth a test: the case is invisible
 * to every DB-backed assertion in this file.
 */
describe("insertInvocation unique-violation classification", () => {
  /**
   * A minimal drizzle-shaped runner: `stagingCorrelation`'s select resolves, and
   * the ledger insert rejects with `err`. The cast is the test's, not production
   * code's — `DbRunner` is drizzle's full builder surface and only these two
   * chains are reached.
   */
  function runnerThatRejectsInsertWith(err: unknown): Parameters<typeof insertInvocation>[1] {
    const correlation = [{ traceId: "run_fake", stepId: "step_fake", toolCallId: "tc_fake" }];
    // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
    return {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve(correlation) }) }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.reject(err) }) }),
    } as unknown as Parameters<typeof insertInvocation>[1];
  }

  /** A wrapped driver error, the shape drizzle actually throws. */
  function wrappedPgError(fields: { code: string; constraint?: string }): Error {
    return new Error("Failed query", { cause: Object.assign(new Error("duplicate key"), fields) });
  }

  /* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */
  const values = {
    userId: "u_fake",
    connectionId: "conn_fake",
    stagingId: "stg_fake",
    remoteName: "do_thing",
    argsHash: "sha256:fake",
  } as unknown as Parameters<typeof insertInvocation>[0];
  /* eslint-enable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion */

  test("an unnamed unique violation still defaults to the barrier", async () => {
    const result = await insertInvocation(
      values,
      runnerThatRejectsInsertWith(wrappedPgError({ code: "23505" })),
    );
    assert.deepEqual(result, { ok: false, reason: "barrier" });
  });

  test("a named staging-index violation is still distinguished", async () => {
    const result = await insertInvocation(
      values,
      runnerThatRejectsInsertWith(
        wrappedPgError({ code: "23505", constraint: "mcp_invocation_staging_idx" }),
      ),
    );
    assert.deepEqual(result, { ok: false, reason: "duplicate_staging" });
  });

  test("a non-unique-violation error is rethrown, not classified", async () => {
    await assert.rejects(
      insertInvocation(values, runnerThatRejectsInsertWith(wrappedPgError({ code: "23503" }))),
      // The ORIGINAL wrapper is rethrown untouched — not re-wrapped, and not
      // swallowed into a typed result. A foreign-key violation is a real failure.
      /Failed query/,
    );
  });
});

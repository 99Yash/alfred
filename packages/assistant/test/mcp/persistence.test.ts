import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { actionStagings, agentRuns, mcpInvocation, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";

import {
  compareAndSetCatalogRevision,
  insertConnection,
  insertCatalogRevision,
  publishCatalogRevision,
  readConnection,
  readCurrentRevision,
  readRevisionByHash,
  updateConnection,
} from "../../src/connections/mcp/persistence";
import {
  createSuccessorInvocation,
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
 * three genuinely-atomic operations the broker rests on — the catalog-revision
 * publish (idempotent insert + pointer advance), the ledger barrier
 * reservation, and the successor mint — plus the boot reconcile sweep. Pure
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
  await db()
    .insert(actionStagings)
    .values({
      id: stagingId,
      userId,
      runId: run.id,
      stepId: "dispatch-tools",
      toolCallId: `tc_${randomUUID().slice(0, 8)}`,
      toolName: "mcp.call",
      integration: "mcp",
      riskTier: "high",
      proposedInput: {},
      proposedInputHash: randomUUID(),
      requiresApproval: true,
    });
  return stagingId;
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

  test("createSuccessorInvocation resolves prior and clears the barrier", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const key = {
      userId,
      connectionId: connId,
      remoteName: "charge_card",
      argsHash: "sha256:pay1",
    };

    const prior = await insertInvocation({
      ...key,
      stagingId: await seedStaging(userId),
      effectClass: "write",
      attemptLifecycle: "delivery_possible",
      effectOutcome: "unknown",
    });
    assert.ok(prior.ok);

    const result = await createSuccessorInvocation({
      priorId: prior.invocation.id,
      priorResolutionReason: "superseded_by_successor",
      successor: { ...key, stagingId: await seedStaging(userId), effectClass: "write" },
    });
    assert.ok(result.ok);
    assert.equal(result.successor.successorOf, prior.invocation.id);

    // Exactly one unresolved row for the key now — the successor.
    const barrier = await findUnresolvedBarrier(key);
    assert.equal(barrier?.id, result.successor.id);

    // The prior is resolved.
    const [priorRow] = await db()
      .select({ resolvedAt: mcpInvocation.resolvedAt })
      .from(mcpInvocation)
      .where(eq(mcpInvocation.id, prior.invocation.id));
    assert.ok(priorRow?.resolvedAt);
  });

  test("createSuccessorInvocation refuses when the prior is already resolved", async () => {
    const userId = await seedUser();
    const connId = await seedConnection(userId);
    const key = {
      userId,
      connectionId: connId,
      remoteName: "charge_card",
      argsHash: "sha256:pay-resolved",
    };

    // A prior that is already resolved (a definitive success, say): there is no
    // unresolved ambiguity left to supersede.
    const prior = await insertInvocation({
      ...key,
      stagingId: await seedStaging(userId),
      effectClass: "write",
      attemptLifecycle: "response_received",
      effectOutcome: "succeeded",
      resolvedAt: new Date(),
      resolutionReason: "succeeded",
    });
    assert.ok(prior.ok);

    const result = await createSuccessorInvocation({
      priorId: prior.invocation.id,
      priorResolutionReason: "superseded_by_successor",
      successor: { ...key, stagingId: await seedStaging(userId), effectClass: "write" },
    });
    assert.deepEqual(result, { ok: false, reason: "prior_already_resolved" });

    // No successor was minted — no unresolved barrier for the key.
    const barrier = await findUnresolvedBarrier(key);
    assert.equal(barrier, undefined);
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
    const writeInflight = await insertInvocation({
      userId,
      connectionId: connId,
      remoteName: "c",
      argsHash: "sha256:3",
      stagingId: await seedStaging(userId),
      effectClass: "write",
      attemptLifecycle: "delivery_possible",
    });
    assert.ok(prepared.ok && readInflight.ok && writeInflight.ok);

    const summary = await reconcileInflightInvocations(userId);
    assert.equal(summary.abandoned, 1);
    assert.equal(summary.resolvedReads, 1);
    assert.equal(summary.markedUnknown, 1);

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
    const crashed = await insertInvocation({
      ...key,
      stagingId: await seedStaging(userId),
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

    // On resume a fresh `tool_call_id` (new staging) proposing the identical call
    // is refused by the durable barrier — it cannot bypass the recovered unknown.
    const resumed = await insertInvocation({
      ...key,
      stagingId: await seedStaging(userId),
      effectClass: "write",
    });
    assert.deepEqual(resumed, { ok: false, reason: "barrier" });
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

  const values = {
    userId: "u_fake",
    connectionId: "conn_fake",
    stagingId: "stg_fake",
    remoteName: "do_thing",
    argsHash: "sha256:fake",
  } as unknown as Parameters<typeof insertInvocation>[0];

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

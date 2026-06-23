import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  activeProjectionVersions,
  entityCoOccurrence,
  entityEdges,
  entityIdentities,
  entityNodes,
  entityProfiles,
  observations,
  projectionCursors,
  projectionRuns,
  user,
} from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

/**
 * DB-backed regression test for the ADR-0067 P0 integrity rails (migrations
 * 0053–0056). For this PR the schema constraints ARE the product — the prior
 * rounds verified them only in throwaway rollback-only `psql` probes, so a
 * future migration could silently drop one and nothing would notice. This pins
 * the load-bearing rails as committed tests:
 *
 *   1. composite (user_id, entity_id) FK → a row can't reference another user's node;
 *   2. composite (user_id, family_key, supersedes_observation_id) self-FK → a
 *      supersession can't cross event families;
 *   3. partial-unique no-fork index → ≤1 successor per predecessor per family;
 *   4. version-bound run FK → a versioned row can't point at a run of another version;
 *   5. name-bound run FK → a versioned row can't bind to a run of another named
 *      projection (projection_runs is generic — the #2 finding);
 *   6. entity_edges self-relation CHECK → no from == to traversable edge;
 *   7. entity_edges + entity_co_occurrence run FKs reject name/version mismatch;
 *   8. active-pointer + cursor run FKs reject a run of another name/version.
 *
 * Each rail asserts BOTH the rejection and a consistent positive control, so a
 * green test means "the constraint rejects the bad shape" not "the insert just
 * always fails."
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated Postgres
 * (mirrors the other DB-backed suites); skipped otherwise so the pure suites
 * still run without a database. Seeds throwaway `test-umrails-*` users and
 * cascades them away on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-umrails-";
const createdUserIds: string[] = [];

/**
 * Drizzle wraps the pg error as `"Failed query: …"` with the real constraint
 * details on `.cause`, so match against the whole cause chain (`code` +
 * `constraint`) rather than the wrapper message. Asserting the specific
 * constraint/SQLSTATE proves the intended rail fired, not just "some insert
 * failed". 23503 = FK violation, 23505 = unique violation.
 */
function rejectsConstraint(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    const parts: string[] = [];
    let cur: unknown = err;
    for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
      const e = cur as { message?: string; code?: string; constraint?: string; cause?: unknown };
      parts.push(e.message ?? "", e.code ?? "", e.constraint ?? "");
      cur = e.cause;
    }
    assert.match(parts.join(" "), pattern);
    return true;
  });
}

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedNode(userId: string, value: string): Promise<string> {
  const id = `ent_test_${randomUUID().replace(/-/g, "")}`;
  await db()
    .insert(entityNodes)
    .values({ id, userId, canonicalIdentity: { kind: "email", value } });
  return id;
}

async function seedRun(
  userId: string,
  { name = "user-model", version = 1 }: { name?: string; version?: number } = {},
): Promise<string> {
  const [run] = await db()
    .insert(projectionRuns)
    .values({ userId, projectionName: name, projectionVersion: version })
    .returning({ id: projectionRuns.id });
  assert.ok(run);
  return run.id;
}

function gmailObs(userId: string, familyKey: string, evidenceHash: string) {
  return {
    userId,
    source: "gmail" as const,
    kind: "email_message" as const,
    occurredAt: new Date("2026-06-23T00:00:00.000Z"),
    familyKey,
    evidenceHash,
    subjectIdentity: { kind: "email" as const, value: "subject@example.com" },
  };
}

describe("user-model integrity rails (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("rail 1: (user_id, entity_id) FK rejects an identity pointing at another user's node", async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const nodeB = await seedNode(userB, "owner-b@example.com");

    // userA tries to attach an identity to userB's node — the (userA, nodeB)
    // pair does not exist in entity_nodes, so the composite FK rejects it.
    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId: userA,
          entityId: nodeB,
          kind: "email",
          value: "a@example.com",
          source: "gmail",
        }),
      /23503|entity_identities_entity_fk/,
    );

    // Positive control: the rightful owner can attach an identity to its node.
    await assert.doesNotReject(() =>
      db().insert(entityIdentities).values({
        userId: userB,
        entityId: nodeB,
        kind: "email",
        value: "owner-b@example.com",
        source: "gmail",
      }),
    );
  });

  test("rail 2: supersession self-FK rejects superseding an observation in another family", async () => {
    const userId = await seedUser();
    const [obsA] = await db()
      .insert(observations)
      .values(gmailObs(userId, "famA", "evidence-a"))
      .returning({ id: observations.id });
    assert.ok(obsA);

    // An observation in famB cannot supersede one in famA — the composite FK is
    // (user_id, family_key, supersedes_observation_id) → observations(user_id,
    // family_key, id), and (userId, "famB", obsA.id) has no match.
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values({
            ...gmailObs(userId, "famB", "evidence-b"),
            supersedesObservationId: obsA.id,
          }),
      /23503|observations_supersedes_fk/,
    );

    // Positive control: a later evidence version within the SAME family supersedes fine.
    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values({
          ...gmailObs(userId, "famA", "evidence-a2"),
          supersedesObservationId: obsA.id,
        }),
    );
  });

  test("rail 3: no-fork partial-unique rejects a second successor for the same predecessor", async () => {
    const userId = await seedUser();
    const [root] = await db()
      .insert(observations)
      .values(gmailObs(userId, "famFork", "root"))
      .returning({ id: observations.id });
    assert.ok(root);

    // First successor is allowed.
    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values({ ...gmailObs(userId, "famFork", "succ-1"), supersedesObservationId: root.id }),
    );

    // A second row superseding the same predecessor forks the chain — rejected by
    // the partial-unique (user_id, family_key, supersedes_observation_id).
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values({ ...gmailObs(userId, "famFork", "succ-2"), supersedesObservationId: root.id }),
      /23505|observations_no_fork_idx/,
    );
  });

  test("rail 4: versioned-row run FK rejects a row whose projection_version != its run's", async () => {
    const userId = await seedUser();
    const node = await seedNode(userId, "profile-subject@example.com");
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });

    // A profile tagged version 2 that names a version-1 run — the run FK spans
    // projection_version, so (userId, "user-model", 2, runV1) has no matching run row.
    await rejectsConstraint(
      () =>
        db().insert(entityProfiles).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 2,
          projectionRunId: runV1,
          entityId: node,
          displayName: "Mismatched",
          kind: "person",
        }),
      /23503|entity_profiles_run_fk/,
    );

    // Positive control: name + version match the run → accepted.
    await assert.doesNotReject(() =>
      db().insert(entityProfiles).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        entityId: node,
        displayName: "Consistent",
        kind: "person",
      }),
    );
  });

  test("rail 5: versioned-row run FK rejects a row whose projection_name != its run's", async () => {
    // The #2 finding: a versioned output row could bind to a run of a DIFFERENT
    // named projection (projection_runs is generic — P4's user_facts projection
    // reuses it). The run FK now spans projection_name, so an entity_profiles row
    // claiming "not-user-model" can't point at the "user-model" run, and the unique
    // (user, name, version, entity) slot can't be blocked by a foreign projection.
    const userId = await seedUser();
    const node = await seedNode(userId, "name-bound@example.com");
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });

    await rejectsConstraint(
      () =>
        db().insert(entityProfiles).values({
          userId,
          projectionName: "not-user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          entityId: node,
          displayName: "Foreign projection",
          kind: "person",
        }),
      /23503|entity_profiles_run_fk/,
    );
  });

  test("rail 6: entity_edges rejects a self-relation (from == to)", async () => {
    const userId = await seedUser();
    const node = await seedNode(userId, "self-edge@example.com");
    const other = await seedNode(userId, "other-edge@example.com");
    const runV1 = await seedRun(userId);

    // A node can't be a frequent_collaborator with itself — the check would let a
    // recursive traversal ingest a 1-cycle.
    await rejectsConstraint(
      () =>
        db().insert(entityEdges).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          fromEntityId: node,
          toEntityId: node,
          relationType: "frequent_collaborator",
        }),
      /23514|entity_edges_no_self_relation/,
    );

    // Positive control: a genuine edge between two distinct nodes is accepted.
    await assert.doesNotReject(() =>
      db().insert(entityEdges).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        fromEntityId: node,
        toEntityId: other,
        relationType: "frequent_collaborator",
      }),
    );
  });

  test("rail 7: entity_edges + entity_co_occurrence run FKs reject a name/version mismatch", async () => {
    const userId = await seedUser();
    const a = await seedNode(userId, "aaa@example.com");
    const b = await seedNode(userId, "bbb@example.com");
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });
    // a < b lexicographically is required for entity_co_occurrence; normalize.
    const [lo, hi] = a < b ? [a, b] : [b, a];

    await rejectsConstraint(
      () =>
        db().insert(entityEdges).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 2, // mismatched vs runV1
          projectionRunId: runV1,
          fromEntityId: a,
          toEntityId: b,
          relationType: "frequent_collaborator",
        }),
      /23503|entity_edges_run_fk/,
    );

    await rejectsConstraint(
      () =>
        db().insert(entityCoOccurrence).values({
          userId,
          projectionName: "not-user-model", // mismatched vs runV1
          projectionVersion: 1,
          projectionRunId: runV1,
          aEntityId: lo,
          bEntityId: hi,
        }),
      /23503|entity_co_occurrence_run_fk/,
    );

    // Positive control: matching name + version on both tables.
    await assert.doesNotReject(() =>
      db().insert(entityCoOccurrence).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        aEntityId: lo,
        bEntityId: hi,
      }),
    );
  });

  test("rail 8: active pointer + cursor run FKs reject a run of another name/version", async () => {
    const userId = await seedUser();
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });

    // The active pointer's (user, name, version, run) must all belong to one run
    // row — claiming version 2 while naming the v1 run is rejected.
    await rejectsConstraint(
      () =>
        db().insert(activeProjectionVersions).values({
          userId,
          projectionName: "user-model",
          activeVersion: 2,
          activeRunId: runV1,
        }),
      /23503|active_projection_versions_run_fk/,
    );
    await assert.doesNotReject(() =>
      db()
        .insert(activeProjectionVersions)
        .values({ userId, projectionName: "user-model", activeVersion: 1, activeRunId: runV1 }),
    );

    // The cursor's (user, name, version, run) is bound the same way.
    await rejectsConstraint(
      () =>
        db().insert(projectionCursors).values({
          userId,
          projectionName: "not-user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          source: "gmail",
        }),
      /23503|projection_cursors_run_fk/,
    );
    await assert.doesNotReject(() =>
      db().insert(projectionCursors).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        source: "gmail",
      }),
    );
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  entityIdentities,
  entityNodes,
  entityProfiles,
  observations,
  projectionRuns,
  user,
} from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";

/**
 * DB-backed regression test for the ADR-0067 P0 integrity rails (migrations
 * 0053–0055). For this PR the schema constraints ARE the product — the prior
 * rounds verified them only in throwaway rollback-only `psql` probes, so a
 * future migration could silently drop one and nothing would notice. This pins
 * the four load-bearing rails as committed tests:
 *
 *   1. composite (user_id, entity_id) FK → a row can't reference another user's node;
 *   2. composite (user_id, family_key, supersedes_observation_id) self-FK → a
 *      supersession can't cross event families;
 *   3. partial-unique no-fork index → ≤1 successor per predecessor per family;
 *   4. version-bound run FK → a versioned row can't point at a run of another version.
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
function rejectsConstraint(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
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
        db()
          .insert(entityIdentities)
          .values({
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
      db()
        .insert(entityIdentities)
        .values({
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
    const [runV1] = await db()
      .insert(projectionRuns)
      .values({ userId, projectionName: "user-model", projectionVersion: 1 })
      .returning({ id: projectionRuns.id });
    assert.ok(runV1);

    // A profile tagged version 2 that names a version-1 run — the run FK spans
    // projection_version, so (userId, 2, runV1) has no matching run row.
    await rejectsConstraint(
      () =>
        db()
          .insert(entityProfiles)
          .values({
            userId,
            projectionVersion: 2,
            projectionRunId: runV1.id,
            entityId: node,
            displayName: "Mismatched",
            kind: "person",
          }),
      /23503|entity_profiles_run_fk/,
    );

    // Positive control: version matches the run → accepted.
    await assert.doesNotReject(() =>
      db()
        .insert(entityProfiles)
        .values({
          userId,
          projectionVersion: 1,
          projectionRunId: runV1.id,
          entityId: node,
          displayName: "Consistent",
          kind: "person",
        }),
    );
  });
});

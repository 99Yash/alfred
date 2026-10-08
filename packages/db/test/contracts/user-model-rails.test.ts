import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { computeStableEntityId, makeEntityNodeInsert } from "@alfred/db/helpers";
import {
  activeProjectionVersions,
  entityCoOccurrence,
  entityEdges,
  entityIdentities,
  entityNodes,
  entityProfiles,
  observationFamilyHeads,
  observations,
  projectionCursors,
  projectionRuns,
  projectionSyncState,
  user,
} from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { dbBackedSkip } from "../support/db-backed";

/**
 * Pins the ADR-0067 user-model DB constraints, so a migration cannot drop one unnoticed.
 * Most rails also run a positive control, so green does not mean "every insert fails".
 * Needs a migrated Postgres; seeds `test-umrails-*` users and cascades them away.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-umrails-";

const createdUserIds: string[] = [];

/**
 * Drizzle puts the pg error on `.cause`, so walk the cause chain.
 * Match the SQLSTATE and the constraint name separately: every FK shares 23503.
 * 23502 = not null, 23503 = FK, 23505 = unique, 23514 = check.
 */
function rejectsConstraint(
  fn: () => Promise<unknown>,
  expected: { code: string; constraint: string },
): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    const parts: string[] = [];
    let cur: unknown = err;

    for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
      const e = cur as { message?: string; code?: string; constraint?: string; cause?: unknown };
      parts.push(e.message ?? "", e.code ?? "", e.constraint ?? "");
      cur = e.cause;
    }

    const haystack = parts.join(" ");
    assert.match(haystack, new RegExp(expected.code), `expected SQLSTATE ${expected.code}`);
    assert.match(
      haystack,
      new RegExp(expected.constraint),
      `expected constraint ${expected.constraint}`,
    );

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

/** Passes the 32-char secret gate. `entity_nodes_id_shape` rejects hand-made ids, so seeds mint real ones. */
const TEST_ENTITY_ID_SECRET = "stable namespace secret for tests";

// `first_seen_at` is the merge tie-break (D2), so seeds use a fixed time, not the clock.
const SEED_FIRST_SEEN_AT = new Date("2026-06-23T00:00:00.000Z");

const SEED_VALID_UNTIL = new Date("2026-06-24T00:00:00.000Z");

async function seedNode(userId: string, value: string): Promise<string> {
  // A hand-built row could let id and `canonical_identity` disagree; the CHECK would not see it.
  const row = makeEntityNodeInsert(
    TEST_ENTITY_ID_SECRET,
    userId,
    { kind: "email", value },
    SEED_FIRST_SEEN_AT,
  );

  await db().insert(entityNodes).values(row);

  return row.id;
}

async function seedRun(
  userId: string,
  {
    name = "user-model",
    version = 1,
    completed = false,
  }: { name?: string; version?: number; completed?: boolean } = {},
): Promise<string> {
  const [run] = await db()
    .insert(projectionRuns)
    .values({
      userId,
      projectionName: name,
      projectionVersion: version,
      // Runs default to `running`. Only a completed run may be activated, so tests that activate seed one.
      ...(completed
        ? {
            status: "completed" as const,
            completedAt: new Date("2026-06-23T00:00:00.000Z"),
            checksum: `checksum-${name}-v${version}`,
          }
        : {}),
    })
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

    // (userA, nodeB) is not a row in entity_nodes.
    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId: userA,
          entityId: nodeB,
          kind: "email",
          value: "a@example.com",
          source: "gmail",
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23503", constraint: "entity_identities_entity_fk" },
    );

    // Positive control: the owner can attach an identity.
    await assert.doesNotReject(() =>
      db().insert(entityIdentities).values({
        userId: userB,
        entityId: nodeB,
        kind: "email",
        value: "owner-b@example.com",
        source: "gmail",
        validFrom: SEED_FIRST_SEEN_AT,
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

    // (userId, "famB", obsA.id) has no match in observations(user_id, family_key, id).
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values({
            ...gmailObs(userId, "famB", "evidence-b"),
            supersedesObservationId: obsA.id,
          }),
      { code: "23503", constraint: "observations_supersedes_fk" },
    );

    // Positive control: same family.
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

    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values({ ...gmailObs(userId, "famFork", "succ-1"), supersedesObservationId: root.id }),
    );

    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values({ ...gmailObs(userId, "famFork", "succ-2"), supersedesObservationId: root.id }),
      { code: "23505", constraint: "observations_no_fork_idx" },
    );
  });

  test("rail 3b: single-root partial-unique rejects a second root in the same family", async () => {
    const userId = await seedUser();

    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values(gmailObs(userId, "famRoot", "root-1")),
    );

    // A new evidence_hash and a NULL supersedes slip past dedup and no-fork.
    // This is the race when two writers both see "no head yet".
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "famRoot", "root-2")),
      { code: "23505", constraint: "observations_single_root_idx" },
    );

    // Positive control: the index constrains only the root, not its successors.
    const [root] = await db()
      .insert(observations)
      .values(gmailObs(userId, "famRootB", "root"))
      .returning({ id: observations.id });

    assert.ok(root);
    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values({ ...gmailObs(userId, "famRootB", "succ"), supersedesObservationId: root.id }),
    );
  });

  test("rail 3c: observation key CHECKs reject empty / padded / oversized family_key and evidence_hash", async () => {
    const userId = await seedUser();

    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "", "hash")),
      {
        code: "23514",
        constraint: "observations_family_key_nonempty",
      },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, " fam-padded ", "hash-padded-family")),
      {
        code: "23514",
        constraint: "observations_family_key_nonempty",
      },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "\tfam-padded", "hash-tab-family")),
      {
        code: "23514",
        constraint: "observations_family_key_nonempty",
      },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "f".repeat(513), "hash-too-long-family")),
      {
        code: "23514",
        constraint: "observations_family_key_nonempty",
      },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "fam", "")),
      {
        code: "23514",
        constraint: "observations_evidence_hash_nonempty",
      },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "famPaddedHash", "hash-padded\n")),
      {
        code: "23514",
        constraint: "observations_evidence_hash_nonempty",
      },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "famTooLongHash", "h".repeat(257))),
      {
        code: "23514",
        constraint: "observations_evidence_hash_nonempty",
      },
    );

    // Positive control.
    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values(gmailObs(userId, "famNonEmpty", "hashNonEmpty")),
    );
  });

  test("rail 4: versioned-row run FK rejects a row whose projection_version != its run's", async () => {
    const userId = await seedUser();
    const node = await seedNode(userId, "profile-subject@example.com");
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });

    // Version 2 row, version 1 run.
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
      { code: "23503", constraint: "entity_profiles_run_fk" },
    );

    // Positive control.
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
    // projection_runs is shared by every projection, so the run FK must include the name.
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
      { code: "23503", constraint: "entity_profiles_run_fk" },
    );
  });

  test("rail 6: entity_edges rejects a self-relation (from == to)", async () => {
    const userId = await seedUser();
    const node = await seedNode(userId, "self-edge@example.com");
    const other = await seedNode(userId, "other-edge@example.com");
    const runV1 = await seedRun(userId);

    // A self-edge is a 1-cycle for a recursive traversal.
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
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23514", constraint: "entity_edges_no_self_relation" },
    );

    // Positive control.
    await assert.doesNotReject(() =>
      db().insert(entityEdges).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        fromEntityId: node,
        toEntityId: other,
        relationType: "frequent_collaborator",
        validFrom: SEED_FIRST_SEEN_AT,
      }),
    );
  });

  test("rail 6b: entity_edges.valid_from has no default and valid_until cannot precede it", async () => {
    const userId = await seedUser();
    const from = await seedNode(userId, "edge-window-from@example.com");
    const to = await seedNode(userId, "edge-window-to@example.com");
    const runV1 = await seedRun(userId);

    await rejectsConstraint(
      () =>
        db()
          .insert(entityEdges)
          .values({
            userId,
            projectionName: "user-model",
            projectionVersion: 1,
            projectionRunId: runV1,
            fromEntityId: from,
            toEntityId: to,
            relationType: "reports_to",
          } as never),
      { code: "23502", constraint: "valid_from" },
    );

    await rejectsConstraint(
      () =>
        db().insert(entityEdges).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          fromEntityId: from,
          toEntityId: to,
          relationType: "reports_to",
          validFrom: SEED_VALID_UNTIL,
          validUntil: SEED_FIRST_SEEN_AT,
        }),
      { code: "23514", constraint: "entity_edges_valid_window" },
    );

    await assert.doesNotReject(() =>
      db().insert(entityEdges).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        fromEntityId: from,
        toEntityId: to,
        relationType: "reports_to",
        validFrom: SEED_FIRST_SEEN_AT,
        validUntil: SEED_VALID_UNTIL,
      }),
    );
  });

  test("rail 7: entity_edges + entity_co_occurrence run FKs reject a name/version mismatch", async () => {
    const userId = await seedUser();
    const a = await seedNode(userId, "aaa@example.com");
    const b = await seedNode(userId, "bbb@example.com");
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });
    // entity_co_occurrence requires a < b.
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
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23503", constraint: "entity_edges_run_fk" },
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
      { code: "23503", constraint: "entity_co_occurrence_run_fk" },
    );

    // Positive control.
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

  test("rail 7b: entity_co_occurrence counters reject impossible states", async () => {
    const userId = await seedUser();
    const a = await seedNode(userId, "cooc-a@example.com");
    const b = await seedNode(userId, "cooc-b@example.com");
    const runV1 = await seedRun(userId, { name: "user-model", version: 1 });
    const [lo, hi] = a < b ? [a, b] : [b, a];

    await rejectsConstraint(
      () =>
        db().insert(entityCoOccurrence).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          aEntityId: lo,
          bEntityId: hi,
          count: 1,
          familyCount: 2,
        }),
      { code: "23514", constraint: "entity_co_occurrence_family_count_lte_count" },
    );

    await rejectsConstraint(
      () =>
        db().insert(entityCoOccurrence).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          aEntityId: lo,
          bEntityId: hi,
          weight: 0.5,
        }),
      { code: "23514", constraint: "entity_co_occurrence_weight_requires_count" },
    );

    await assert.doesNotReject(() =>
      db().insert(entityCoOccurrence).values({
        userId,
        projectionName: "user-model",
        projectionVersion: 1,
        projectionRunId: runV1,
        aEntityId: lo,
        bEntityId: hi,
        weight: 0.5,
        count: 2,
        familyCount: 2,
      }),
    );
  });

  test("rail 8: active pointer + cursor run FKs reject a run of another name/version", async () => {
    const userId = await seedUser();
    // Completed, because the positive control below activates it.
    const runV1 = await seedRun(userId, { name: "user-model", version: 1, completed: true });

    await rejectsConstraint(
      () =>
        db().insert(activeProjectionVersions).values({
          userId,
          projectionName: "user-model",
          activeVersion: 2,
          activeRunId: runV1,
        }),
      { code: "23503", constraint: "active_projection_versions_run_fk" },
    );
    await assert.doesNotReject(() =>
      db()
        .insert(activeProjectionVersions)
        .values({ userId, projectionName: "user-model", activeVersion: 1, activeRunId: runV1 }),
    );

    await rejectsConstraint(
      () =>
        db().insert(projectionCursors).values({
          userId,
          projectionName: "not-user-model",
          projectionVersion: 1,
          projectionRunId: runV1,
          source: "gmail",
        }),
      { code: "23503", constraint: "projection_cursors_run_fk" },
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

  test("rail 9: entity_nodes id-shape CHECK rejects a non-content-addressed id", async () => {
    const userId = await seedUser();

    // Only a `computeStableEntityId` output (`ent_<26 base32>`) may be stored.
    await rejectsConstraint(
      () =>
        db()
          .insert(entityNodes)
          .values({
            id: "not_a_stable_entity_id",
            userId,
            canonicalIdentity: { kind: "email", value: "shape@example.com" },
            // Without it, NOT NULL fires before the id-shape CHECK.
            firstSeenAt: SEED_FIRST_SEEN_AT,
          }),
      { code: "23514", constraint: "entity_nodes_id_shape" },
    );

    // Positive control.
    await assert.doesNotReject(() => seedNode(userId, "valid-shape@example.com"));
  });

  test("rail 9b: entity_nodes.first_seen_at has NO default — a writer that omits it fails loud", async () => {
    const userId = await seedUser();

    // A wall-clock default would break replay of the merge tie-break (D2).
    // The id is valid, so the missing timestamp is the only violation.
    const id = computeStableEntityId(TEST_ENTITY_ID_SECRET, {
      userId,
      identityKind: "email",
      normalizedValue: "no-first-seen@example.com",
    });

    await rejectsConstraint(
      () =>
        db()
          .insert(entityNodes)
          .values({
            id,
            userId,
            canonicalIdentity: { kind: "email", value: "no-first-seen@example.com" },
          } as never),
      // The 23502 message names the column.
      { code: "23502", constraint: "first_seen_at" },
    );
  });

  test("rail 10: entity_identities active partial-unique blocks two LIVE rows but allows reuse of a CLOSED (kind, value)", async () => {
    const userId = await seedUser();
    const nodeA = await seedNode(userId, "reuse-a@example.com");
    const nodeB = await seedNode(userId, "reuse-b@example.com");

    // Pair the kind with a source that can write it (#987).
    const [live] = await db()
      .insert(entityIdentities)
      .values({
        userId,
        entityId: nodeA,
        kind: "email",
        value: "alice@example.com",
        source: "gmail",
        validFrom: SEED_FIRST_SEEN_AT,
      })
      .returning({ id: entityIdentities.id });

    assert.ok(live);

    // One live entity per address, even across entities.
    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId,
          entityId: nodeB,
          kind: "email",
          value: "alice@example.com",
          source: "gmail",
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23505", constraint: "entity_identities_active_unique_idx" },
    );

    // After the first row closes, another entity may reuse the address.
    await db()
      .update(entityIdentities)
      .set({ validUntil: SEED_VALID_UNTIL })
      .where(and(eq(entityIdentities.userId, userId), eq(entityIdentities.id, live.id)));

    await assert.doesNotReject(() =>
      db().insert(entityIdentities).values({
        userId,
        entityId: nodeB,
        kind: "email",
        value: "alice@example.com",
        source: "gmail",
        validFrom: SEED_VALID_UNTIL,
      }),
    );
  });

  test("rail 10b: entity_identities.valid_from has no default and valid_until cannot precede it", async () => {
    const userId = await seedUser();
    const node = await seedNode(userId, "identity-window@example.com");

    await rejectsConstraint(
      () =>
        db()
          .insert(entityIdentities)
          .values({
            userId,
            entityId: node,
            kind: "email",
            value: "no-valid-from@example.com",
            source: "gmail",
          } as never),
      { code: "23502", constraint: "valid_from" },
    );

    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId,
          entityId: node,
          kind: "email",
          value: "bad-window@example.com",
          source: "gmail",
          validFrom: SEED_VALID_UNTIL,
          validUntil: SEED_FIRST_SEEN_AT,
        }),
      { code: "23514", constraint: "entity_identities_valid_window" },
    );

    await assert.doesNotReject(() =>
      db().insert(entityIdentities).values({
        userId,
        entityId: node,
        kind: "email",
        value: "good-window@example.com",
        source: "gmail",
        validFrom: SEED_FIRST_SEEN_AT,
        validUntil: SEED_VALID_UNTIL,
      }),
    );
  });

  test("rail 11: version-positive CHECK rejects a non-positive projection version", async () => {
    const userId = await seedUser();

    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({ userId, projectionName: "user-model", projectionVersion: 0 }),
      { code: "23514", constraint: "projection_runs_version_positive" },
    );

    // Positive control.
    await assert.doesNotReject(() => seedRun(userId, { name: "user-model", version: 1 }));
  });

  test("rail 12: family-head composite FK rejects a head whose (user, family) != its observation's", async () => {
    // A plain FK on head_observation_id would not check the user or the family.
    const userId = await seedUser();

    const [obs] = await db()
      .insert(observations)
      .values(gmailObs(userId, "famHead", "evidence-head"))
      .returning({ id: observations.id });

    assert.ok(obs);

    await rejectsConstraint(
      () =>
        db().insert(observationFamilyHeads).values({
          userId,
          familyKey: "wrongFam",
          headObservationId: obs.id,
        }),
      { code: "23503", constraint: "observation_family_heads_obs_fk" },
    );

    // Positive control.
    await assert.doesNotReject(() =>
      db().insert(observationFamilyHeads).values({
        userId,
        familyKey: "famHead",
        headObservationId: obs.id,
      }),
    );
  });

  test("rail 13: entity_identities value CHECK rejects empty / padded / oversized values", async () => {
    // `value` is the live dedup key; an empty or padded one merges unrelated identities.
    // The DB checks only the kind-independent floor. Per-kind case rules live at the write boundary.
    const userId = await seedUser();
    const node = await seedNode(userId, "value-rail@example.com");

    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId,
          entityId: node,
          kind: "email",
          value: "",
          source: "gmail",
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23514", constraint: "entity_identities_value_nonempty" },
    );
    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId,
          entityId: node,
          kind: "email",
          value: " padded@example.com ",
          source: "gmail",
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23514", constraint: "entity_identities_value_nonempty" },
    );
    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId,
          entityId: node,
          kind: "email",
          value: "tabbed@example.com\n",
          source: "gmail",
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      { code: "23514", constraint: "entity_identities_value_nonempty" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(entityIdentities)
          .values({
            userId,
            entityId: node,
            kind: "email",
            value: `${"x".repeat(1020)}@example.com`,
            source: "gmail",
            validFrom: SEED_FIRST_SEEN_AT,
          }),
      { code: "23514", constraint: "entity_identities_value_nonempty" },
    );

    // Positive control.
    await assert.doesNotReject(() =>
      db().insert(entityIdentities).values({
        userId,
        entityId: node,
        kind: "email",
        value: "value-rail@example.com",
        source: "gmail",
        validFrom: SEED_FIRST_SEEN_AT,
      }),
    );
  });

  test("rail 14: projection identity-key CHECKs reject empty / padded / oversized keys", async () => {
    // These keys feed unique indexes; an empty or padded one collapses unrelated rows into one slot.
    const userId = await seedUser();

    await rejectsConstraint(
      () =>
        db().insert(projectionRuns).values({ userId, projectionName: "", projectionVersion: 1 }),
      { code: "23514", constraint: "projection_runs_name_nonempty" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({ userId, projectionName: " user-model ", projectionVersion: 1 }),
      { code: "23514", constraint: "projection_runs_name_nonempty" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({ userId, projectionName: "\tuser-model", projectionVersion: 1 }),
      { code: "23514", constraint: "projection_runs_name_nonempty" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({ userId, projectionName: "p".repeat(129), projectionVersion: 1 }),
      { code: "23514", constraint: "projection_runs_name_nonempty" },
    );

    for (const bad of [
      {
        syncSlug: "",
        stableKey: "k",
        contentHash: "h",
        constraint: "projection_sync_state_sync_slug_nonempty",
      },
      {
        syncSlug: "s",
        stableKey: "",
        contentHash: "h",
        constraint: "projection_sync_state_stable_key_nonempty",
      },
      {
        syncSlug: "s",
        stableKey: "k",
        contentHash: "",
        constraint: "projection_sync_state_content_hash_nonempty",
      },
      {
        syncSlug: "slug\n",
        stableKey: "k",
        contentHash: "h",
        constraint: "projection_sync_state_sync_slug_nonempty",
      },
      {
        syncSlug: "s".repeat(129),
        stableKey: "k",
        contentHash: "h",
        constraint: "projection_sync_state_sync_slug_nonempty",
      },
      {
        syncSlug: "s",
        stableKey: "\tk",
        contentHash: "h",
        constraint: "projection_sync_state_stable_key_nonempty",
      },
      {
        syncSlug: "s",
        stableKey: "k".repeat(1025),
        contentHash: "h",
        constraint: "projection_sync_state_stable_key_nonempty",
      },
      {
        syncSlug: "s",
        stableKey: "k",
        contentHash: "h\n",
        constraint: "projection_sync_state_content_hash_nonempty",
      },
      {
        syncSlug: "s",
        stableKey: "k",
        contentHash: "h".repeat(257),
        constraint: "projection_sync_state_content_hash_nonempty",
      },
    ]) {
      await rejectsConstraint(
        () =>
          db().insert(projectionSyncState).values({
            userId,
            syncSlug: bad.syncSlug,
            stableKey: bad.stableKey,
            contentHash: bad.contentHash,
          }),
        { code: "23514", constraint: bad.constraint },
      );
    }

    // Positive controls.
    await assert.doesNotReject(() => seedRun(userId, { name: "user-model", version: 1 }));
    await assert.doesNotReject(() =>
      db().insert(projectionSyncState).values({
        userId,
        syncSlug: "active_user_facts",
        stableKey: "fact:tz",
        contentHash: "abc123",
      }),
    );
  });

  test("rail 15: projection_runs lifecycle CHECKs reject illegal terminal states", async () => {
    // `status` is bare text, so a raw writer escapes the TS union. Activation compares the checksum.
    const userId = await seedUser();

    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({
            userId,
            projectionName: "user-model",
            projectionVersion: 1,
            status: "bogus" as never,
          }),
      { code: "23514", constraint: "projection_runs_status_valid" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({
            userId,
            projectionName: "user-model",
            projectionVersion: 1,
            status: "running",
            completedAt: new Date("2026-06-23T00:00:00.000Z"),
          }),
      { code: "23514", constraint: "projection_runs_completed_at_consistency" },
    );
    await rejectsConstraint(
      () =>
        db().insert(projectionRuns).values({
          userId,
          projectionName: "user-model",
          projectionVersion: 2,
          status: "completed",
        }),
      { code: "23514", constraint: "projection_runs_completed_at_consistency" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({
            userId,
            projectionName: "user-model",
            projectionVersion: 3,
            status: "completed",
            completedAt: new Date("2026-06-23T00:00:00.000Z"),
          }),
      { code: "23514", constraint: "projection_runs_completed_checksum_present" },
    );
    await rejectsConstraint(
      () =>
        db()
          .insert(projectionRuns)
          .values({
            userId,
            projectionName: "user-model",
            projectionVersion: 4,
            status: "completed",
            completedAt: new Date("2026-06-23T00:00:00.000Z"),
            checksum: " checksum ",
          }),
      { code: "23514", constraint: "projection_runs_completed_checksum_present" },
    );

    // Positive controls.
    await assert.doesNotReject(() => seedRun(userId, { name: "user-model", version: 5 }));
    await assert.doesNotReject(() =>
      seedRun(userId, { name: "user-model", version: 6, completed: true }),
    );
  });
});

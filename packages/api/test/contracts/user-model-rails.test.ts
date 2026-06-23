import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { makeEntityNodeInsert } from "@alfred/db/helpers";
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

/**
 * DB-backed regression test for the ADR-0067 P0 integrity rails (migrations
 * 0053–0062). For this PR the schema constraints ARE the product — the prior
 * rounds verified them only in throwaway rollback-only `psql` probes, so a
 * future migration could silently drop one and nothing would notice. This pins
 * the load-bearing rails as committed tests:
 *
 *   1. composite (user_id, entity_id) FK → a row can't reference another user's node;
 *   2. composite (user_id, family_key, supersedes_observation_id) self-FK → a
 *      supersession can't cross event families;
 *   3. partial-unique no-fork index → ≤1 successor per predecessor per family;
 *  3b. partial-unique single-root index → ≤1 unsuperseded root per family (the
 *      no-fork index's mirror: it serializes successors but is silent on the head);
 *  3c. non-empty CHECKs on family_key / evidence_hash → the two idempotency rails
 *      can't be empty strings that collapse families or dedup every member;
 *   4. version-bound run FK → a versioned row can't point at a run of another version;
 *   5. name-bound run FK → a versioned row can't bind to a run of another named
 *      projection (projection_runs is generic — the #2 finding);
 *   6. entity_edges self-relation CHECK → no from == to traversable edge;
 *   7. entity_edges + entity_co_occurrence run FKs reject name/version mismatch;
 *   8. active-pointer + cursor run FKs reject a run of another name/version;
 *   9. entity_nodes id-shape CHECK → only `ent_<26 base32>` content-addressed ids;
 *  10. entity_identities active partial-unique → ≤1 LIVE `(kind, value)`, but a
 *      CLOSED row may repeat it (mutable-handle reuse the temporal columns exist for);
 *  11. version-positive CHECK → projection/schema/reducer versions are 1-based;
 *  12. observation_family_heads composite FK → a head can't point at an
 *      observation from a different (user, family);
 *  13. entity_identities value-nonempty CHECK → the live dedup key can't be an
 *      empty / whitespace-padded value (a merge magnet).
 *  14. projection identity-key non-empty CHECKs → projection_name and the
 *      sync-state slug/key/hash (replay/sync keys feeding the unique indexes)
 *      can't be empty / whitespace-padded slots that collapse unrelated rows;
 *  15. projection_runs status + completed_at CHECKs → status is one of the legal
 *      three and completed_at agrees with it (running⇒null, completed⇒not-null).
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
 * details on `.cause`, so we walk the whole cause chain rather than the wrapper
 * message. Asserts the expected SQLSTATE AND the expected constraint name
 * SEPARATELY — an OR over `(code | constraint)` would pass for ANY violation
 * sharing the SQLSTATE (e.g. any FK is 23503), so a different constraint firing
 * would still go green and give false confidence that the intended rail fired.
 * Requiring both proves THIS constraint rejected the bad shape, not just "some
 * insert with this SQLSTATE failed". 23503 = FK violation, 23505 = unique
 * violation, 23514 = check violation.
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

/**
 * 32+ char, no surrounding whitespace — clears `computeStableEntityId`'s secret
 * gate. The id-shape CHECK (`entity_nodes_id_shape`) rejects the old
 * `ent_test_<uuid>` shape (uuids carry `0`/`1`/`8`/`9`, outside base32 `[a-z2-7]`),
 * so seeds must mint a REAL content-addressed id — which also makes the seeded
 * `canonical_identity` consistent with the id, the way a P1 writer would.
 */
const TEST_ENTITY_ID_SECRET = "stable namespace secret for tests";

// Fixed observation time for seeds — `makeEntityNodeInsert` requires the earliest
// observation timestamp (the merge tie-break, D2), never a wall clock, so replay
// ordering stays deterministic. A constant is fine for these structural rails.
const SEED_FIRST_SEEN_AT = new Date("2026-06-23T00:00:00.000Z");

async function seedNode(userId: string, value: string): Promise<string> {
  // Route through `makeEntityNodeInsert` (the write API) so the seeded id is, by
  // construction, the content address of its `canonical_identity` — the way a P1
  // writer must mint it; a hand-assembled `{ id, canonicalIdentity }` could put
  // the two out of sync, which the id-shape CHECK would NOT catch.
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
      // A run defaults to `running`. Activation is a completed-only cutover (the
      // guard lives in the P1 activation helper — a FK can't assert status), so
      // any test that activates a run must seed it as a legitimately finished one
      // rather than normalizing a domain-invalid "activate a still-running run."
      ...(completed
        ? { status: "completed" as const, completedAt: new Date("2026-06-23T00:00:00.000Z") }
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
      { code: "23503", constraint: "entity_identities_entity_fk" },
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
      { code: "23503", constraint: "observations_supersedes_fk" },
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
      { code: "23505", constraint: "observations_no_fork_idx" },
    );
  });

  test("rail 3b: single-root partial-unique rejects a second root in the same family", async () => {
    const userId = await seedUser();

    // The first observation in a family is its root (supersedes IS NULL).
    await assert.doesNotReject(() =>
      db()
        .insert(observations)
        .values(gmailObs(userId, "famRoot", "root-1")),
    );

    // A second root for the same (user, family_key) — different evidence_hash, so
    // it dodges the dedup index, and supersedes IS NULL, so it dodges no-fork
    // (which is partial on IS NOT NULL). That forks the family at the HEAD. The
    // single-root partial-unique (user_id, family_key) WHERE supersedes IS NULL
    // rejects it, so a family stays one linear chain end-to-end. This is the race
    // two writers hit when both see "no head yet" — the second must retry against
    // the now-existing head instead of planting a rival root.
    await rejectsConstraint(
      () =>
        db()
          .insert(observations)
          .values(gmailObs(userId, "famRoot", "root-2")),
      { code: "23505", constraint: "observations_single_root_idx" },
    );

    // Positive control: a proper successor (supersedes set) is still allowed — the
    // index only constrains the unsuperseded root, not the chain below it.
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

  test("rail 3c: non-empty CHECKs reject empty family_key / evidence_hash", async () => {
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
          .values(gmailObs(userId, "fam", "")),
      {
        code: "23514",
        constraint: "observations_evidence_hash_nonempty",
      },
    );

    // Positive control: both non-empty inserts cleanly.
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
      { code: "23503", constraint: "entity_profiles_run_fk" },
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
      { code: "23503", constraint: "entity_profiles_run_fk" },
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
      { code: "23514", constraint: "entity_edges_no_self_relation" },
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
    // Completed: the active-pointer positive control activates this run, and a
    // real cutover only ever activates a finished run.
    const runV1 = await seedRun(userId, { name: "user-model", version: 1, completed: true });

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
      { code: "23503", constraint: "active_projection_versions_run_fk" },
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

    // The id is the FK contract surface — it may ONLY be a `computeStableEntityId`
    // output (`ent_<26 base32>`). A hand-written id can't be persisted.
    await rejectsConstraint(
      () =>
        db()
          .insert(entityNodes)
          .values({
            id: "not_a_stable_entity_id",
            userId,
            canonicalIdentity: { kind: "email", value: "shape@example.com" },
          }),
      { code: "23514", constraint: "entity_nodes_id_shape" },
    );

    // Positive control: a real minted id is accepted (seedNode mints via computeStableEntityId).
    await assert.doesNotReject(() => seedNode(userId, "valid-shape@example.com"));
  });

  test("rail 10: entity_identities active partial-unique blocks two LIVE rows but allows reuse of a CLOSED (kind, value)", async () => {
    const userId = await seedUser();
    const nodeA = await seedNode(userId, "reuse-a@example.com");
    const nodeB = await seedNode(userId, "reuse-b@example.com");

    // A live github_login `alice` on nodeA.
    const [live] = await db()
      .insert(entityIdentities)
      .values({ userId, entityId: nodeA, kind: "github_login", value: "alice", source: "github" })
      .returning({ id: entityIdentities.id });
    assert.ok(live);

    // A SECOND live row for the same (kind, value) — even on a different entity —
    // collides on the partial unique (a `github_login` resolves to one live entity).
    await rejectsConstraint(
      () =>
        db().insert(entityIdentities).values({
          userId,
          entityId: nodeB,
          kind: "github_login",
          value: "alice",
          source: "github",
        }),
      { code: "23505", constraint: "entity_identities_active_unique_idx" },
    );

    // Close the original (the GitHub login was freed), then a NEW live row for the
    // reclaimed login on a DIFFERENT entity is allowed — the mutable-handle reuse
    // the temporal columns exist for, which a globally-unique index would block.
    await db()
      .update(entityIdentities)
      .set({ validUntil: new Date("2026-06-23T00:00:00.000Z") })
      .where(and(eq(entityIdentities.userId, userId), eq(entityIdentities.id, live.id)));

    await assert.doesNotReject(() =>
      db().insert(entityIdentities).values({
        userId,
        entityId: nodeB,
        kind: "github_login",
        value: "alice",
        source: "github",
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

    // Positive control: version 1 is accepted.
    await assert.doesNotReject(() => seedRun(userId, { name: "user-model", version: 1 }));
  });

  test("rail 12: family-head composite FK rejects a head whose (user, family) != its observation's", async () => {
    // The schema calls observation_family_heads_obs_fk load-bearing — it binds
    // (user_id, family_key, head_observation_id) → observations(user_id,
    // family_key, id) so a head can't point at another user's (or family's)
    // observation — but no prior rail exercised it. A plain FK on
    // head_observation_id alone would prove only that the observation exists.
    const userId = await seedUser();
    const [obs] = await db()
      .insert(observations)
      .values(gmailObs(userId, "famHead", "evidence-head"))
      .returning({ id: observations.id });
    assert.ok(obs);

    // A head claiming family "wrongFam" but pointing at an observation in
    // "famHead" — (userId, "wrongFam", obs.id) has no matching observations row.
    await rejectsConstraint(
      () =>
        db().insert(observationFamilyHeads).values({
          userId,
          familyKey: "wrongFam",
          headObservationId: obs.id,
        }),
      { code: "23503", constraint: "observation_family_heads_obs_fk" },
    );

    // Positive control: a head bound to the observation's real (user, family) is accepted.
    await assert.doesNotReject(() =>
      db().insert(observationFamilyHeads).values({
        userId,
        familyKey: "famHead",
        headObservationId: obs.id,
      }),
    );
  });

  test("rail 13: entity_identities value-nonempty CHECK rejects empty / whitespace-padded values", async () => {
    // `value` is the live dedup key (`entity_identities_active_unique_idx`) and the
    // join target observations resolve through — an empty or whitespace-padded
    // value is a merge magnet / split-brain. The DB pins the kind-independent floor
    // (non-empty + no surrounding whitespace); per-kind CASE canonicalization is
    // enforced above the DB at the write boundary (it needs the contract canonicalizer).
    const userId = await seedUser();
    const node = await seedNode(userId, "value-rail@example.com");

    await rejectsConstraint(
      () =>
        db()
          .insert(entityIdentities)
          .values({ userId, entityId: node, kind: "email", value: "", source: "gmail" }),
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
            value: " padded@example.com ",
            source: "gmail",
          }),
      { code: "23514", constraint: "entity_identities_value_nonempty" },
    );

    // Positive control: a clean canonical value inserts.
    await assert.doesNotReject(() =>
      db()
        .insert(entityIdentities)
        .values({
          userId,
          entityId: node,
          kind: "email",
          value: "value-rail@example.com",
          source: "gmail",
        }),
    );
  });

  test("rail 14: non-empty CHECKs reject empty / whitespace-padded projection identity keys", async () => {
    // `projection_name` (and the sync-state slug/key/hash) are replay/sync identity
    // keys feeding the unique indexes — an empty or padded value collapses unrelated
    // projections or sync rows into one slot. Same kind-independent floor as the
    // family_key / evidence_hash / entity_identities.value rails.
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
    ]) {
      await rejectsConstraint(
        () =>
          db()
            .insert(projectionSyncState)
            .values({
              userId,
              syncSlug: bad.syncSlug,
              stableKey: bad.stableKey,
              contentHash: bad.contentHash,
            }),
        { code: "23514", constraint: bad.constraint },
      );
    }

    // Positive controls: clean keys insert.
    await assert.doesNotReject(() => seedRun(userId, { name: "user-model", version: 1 }));
    await assert.doesNotReject(() =>
      db()
        .insert(projectionSyncState)
        .values({
          userId,
          syncSlug: "active_user_facts",
          stableKey: "fact:tz",
          contentHash: "abc123",
        }),
    );
  });

  test("rail 15: projection_runs status + completed_at CHECKs reject illegal lifecycle states", async () => {
    // `status` is bare text the TS union can't police at a raw writer, and
    // `completed_at` must agree with it (a `running` run has no completion time; a
    // `completed` run must have one — the active pointer only cuts over to completed
    // runs). The completed-only ACTIVATION guard still lives in the P1 helper.
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
    // running + a completion time is contradictory.
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
    // completed with no completion time is contradictory.
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

    // Positive controls: a default `running` run (no completedAt) and a finished
    // `completed` run (with completedAt) both insert.
    await assert.doesNotReject(() => seedRun(userId, { name: "user-model", version: 3 }));
    await assert.doesNotReject(() =>
      seedRun(userId, { name: "user-model", version: 4, completed: true }),
    );
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { databaseEnv } from "@alfred/env/database";
import { makeEntityNodeInsert } from "@alfred/db/helpers";
import {
  activeProjectionVersions,
  entityNodes,
  entityProfiles,
  observationFamilyHeads,
  observations,
  projectionCursors,
  projectionRuns,
  user,
} from "@alfred/db/schemas";
import { USER_MODEL_PROJECTION_NAME } from "@alfred/contracts";
import { and, eq, inArray } from "drizzle-orm";

import {
  activateProjectionVersion,
  appendObservationFamilyMember,
  completeProjectionRun,
  EntityIdentityConflictError,
  ensureEntityNode,
  failProjectionRun,
  insertObservation,
  recordEntityIdentity,
  startProjectionRun,
  userModelReader,
  writeProjectionCursor,
} from "../../src/modules/user-model";

/**
 * DB-backed behavior test for the ADR-0067 P1 WRITE BOUNDARY + read surface — the
 * complement to `user-model-rails.test.ts` (which pins the raw DB constraints).
 * This proves the helpers that route every substrate write/read:
 *
 *   - `insertObservation`: validated append, dedup is a no-op, the family head
 *     pointer moves to the new live member, and a no-fork/single-root violation
 *     is NOT swallowed (it surfaces for the reducer's CAS retry);
 *   - `recordEntityIdentity`: idempotent over the ACTIVE `(kind, value)` set;
 *   - `startProjectionRun` / `completeProjectionRun`: single-attempt reuse +
 *     completed runs require a checksum;
 *   - `activateProjectionVersion`: the completed-only guard a FK can't express;
 *   - `userModelReader`: empty until activated, then pinned to the active run
 *     (a non-active version's rows are invisible).
 *
 * Seeds nodes through `makeEntityNodeInsert` with a fixed test secret (same as
 * the rails test) so it needs only `DATABASE_URL`, not the full `serverEnv`.
 */
function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}
const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-umwriters-";
const TEST_ENTITY_ID_SECRET = "stable namespace secret for tests";
const SEED_FIRST_SEEN_AT = new Date("2026-06-23T00:00:00.000Z");
const createdUserIds: string[] = [];

const SERVER_ENV_FIXTURES: Record<string, string> = {
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "test better auth secret with length",
  BETTER_AUTH_URL: "http://localhost:3001",
  ALFRED_ALLOWED_EMAIL: "test@example.com",
  RESEND_API_KEY: "test-resend",
  RESEND_FROM_EMAIL: "Alfred <noreply@example.com>",
  ANTHROPIC_API_KEY: "test-anthropic",
  GOOGLE_GENERATIVE_AI_API_KEY: "test-google-ai",
  GOOGLE_OAUTH_CLIENT_ID: "test-google-client",
  GOOGLE_OAUTH_CLIENT_SECRET: "test-google-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/auth/callback/google",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_CLIENT_ID: "test-github-client",
  GITHUB_APP_CLIENT_SECRET: "test-github-secret",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_REDIRECT_URI: "http://localhost:3001/api/integrations/github/callback",
  ENTITY_ID_NAMESPACE: TEST_ENTITY_ID_SECRET,
};

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedNode(userId: string, value: string): Promise<string> {
  const row = makeEntityNodeInsert(
    TEST_ENTITY_ID_SECRET,
    userId,
    { kind: "email", value },
    SEED_FIRST_SEEN_AT,
  );
  await db().insert(entityNodes).values(row).onConflictDoNothing({ target: entityNodes.id });
  return row.id;
}

function seedServerEnvForStableIds(): void {
  for (const [key, value] of Object.entries(SERVER_ENV_FIXTURES)) {
    process.env[key] ??= value;
  }
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
    payload: {
      provider: "gmail" as const,
      documentId: "doc_test",
      messageId: "gmail_msg_test",
      threadId: "gmail_thread_test",
      accountId: "acct_test",
      isSent: false,
      subject: "Test subject",
      subjectHash: "sha256:test",
      headers: {
        messageId: "<gmail_msg_test@example.com>",
        inReplyTo: null,
        references: [],
        listId: null,
        listUnsubscribe: null,
        replyTo: null,
        deliveredTo: null,
        autoSubmitted: null,
        precedence: null,
      },
    },
  };
}

describe("user-model write boundary (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("insertObservation appends, points the family head, and dedups identically", async () => {
    const userId = await seedUser();
    const familyKey = `gmail:${randomUUID()}`;

    const first = await insertObservation(gmailObs(userId, familyKey, "hash-a"));
    assert.equal(first.deduped, false);

    // Head points at the new row.
    const [head] = await db()
      .select()
      .from(observationFamilyHeads)
      .where(
        and(
          eq(observationFamilyHeads.userId, userId),
          eq(observationFamilyHeads.familyKey, familyKey),
        ),
      );
    assert.ok(head);
    assert.equal(head.headObservationId, first.observation.id);

    // Identical evidence dedups to the SAME row, no new insert, head unchanged.
    const again = await insertObservation(gmailObs(userId, familyKey, "hash-a"));
    assert.equal(again.deduped, true);
    assert.equal(again.observation.id, first.observation.id);

    const rows = await db()
      .select()
      .from(observations)
      .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)));
    assert.equal(rows.length, 1, "dedup must not append a second row");
  });

  test("insertObservation moves the head to a superseding member", async () => {
    const userId = await seedUser();
    const familyKey = `gmail:${randomUUID()}`;

    const root = await insertObservation(gmailObs(userId, familyKey, "hash-root"));
    const successor = await insertObservation({
      ...gmailObs(userId, familyKey, "hash-successor"),
      supersedesObservationId: root.observation.id,
    });
    assert.equal(successor.deduped, false);

    const [head] = await db()
      .select()
      .from(observationFamilyHeads)
      .where(
        and(
          eq(observationFamilyHeads.userId, userId),
          eq(observationFamilyHeads.familyKey, familyKey),
        ),
      );
    assert.equal(head?.headObservationId, successor.observation.id);
  });

  test("appendObservationFamilyMember sets supersedes from the active family head", async () => {
    const userId = await seedUser();
    const familyKey = `gmail:${randomUUID()}`;

    const root = await appendObservationFamilyMember(gmailObs(userId, familyKey, "hash-root"));
    assert.equal(root.status, "inserted");
    assert.equal(root.observation.supersedesObservationId, null);

    const successor = await appendObservationFamilyMember(
      gmailObs(userId, familyKey, "hash-successor"),
    );
    assert.equal(successor.status, "inserted");
    assert.equal(successor.observation.supersedesObservationId, root.observation.id);

    const again = await appendObservationFamilyMember(
      gmailObs(userId, familyKey, "hash-successor"),
    );
    assert.equal(again.status, "deduped");
    assert.equal(again.observation.id, successor.observation.id);

    const [head] = await db()
      .select()
      .from(observationFamilyHeads)
      .where(
        and(
          eq(observationFamilyHeads.userId, userId),
          eq(observationFamilyHeads.familyKey, familyKey),
        ),
      );
    assert.equal(head?.headObservationId, successor.observation.id);
  });

  test("appendObservationFamilyMember serializes concurrent appends for one family", async () => {
    const userId = await seedUser();
    const familyKey = `gmail:${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        appendObservationFamilyMember(gmailObs(userId, familyKey, `hash-concurrent-${index}`)),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ["inserted", "inserted", "inserted", "inserted", "inserted"],
    );

    const rows = await db()
      .select({
        id: observations.id,
        supersedesObservationId: observations.supersedesObservationId,
      })
      .from(observations)
      .where(and(eq(observations.userId, userId), eq(observations.familyKey, familyKey)));
    assert.equal(rows.length, 5);
    assert.equal(
      rows.filter((row) => row.supersedesObservationId === null).length,
      1,
      "a concurrently-created family must have exactly one root",
    );

    const predecessorIds = rows
      .map((row) => row.supersedesObservationId)
      .filter((id): id is string => id !== null);
    assert.equal(
      new Set(predecessorIds).size,
      predecessorIds.length,
      "no two rows should supersede the same predecessor",
    );
  });

  test("insertObservation rejects a kind not valid for its source (parse gate)", async () => {
    const userId = await seedUser();
    await assert.rejects(
      () =>
        insertObservation({
          ...gmailObs(userId, `gmail:${randomUUID()}`, "hash-x"),
          kind: "github_push",
        }),
      /not valid for its source/,
    );
  });

  test("insertObservation does NOT swallow a single-root fork (CAS signal surfaces)", async () => {
    const userId = await seedUser();
    const familyKey = `gmail:${randomUUID()}`;
    await insertObservation(gmailObs(userId, familyKey, "hash-1"));
    // A SECOND root (distinct evidence, no supersedes) must collide on the
    // single-root index, not be silently dropped — the reducer retries on this.
    // Drizzle wraps the pg error as "Failed query: …" with the constraint name +
    // SQLSTATE on `.cause`, so walk the chain rather than the wrapper message.
    await assert.rejects(
      () => insertObservation(gmailObs(userId, familyKey, "hash-2")),
      (err: unknown) => {
        const parts: string[] = [];
        let cur: unknown = err;
        for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
          const e = cur as {
            message?: string;
            code?: string;
            constraint?: string;
            cause?: unknown;
          };
          parts.push(e.message ?? "", e.code ?? "", e.constraint ?? "");
          cur = e.cause;
        }
        const haystack = parts.join(" ");
        assert.match(haystack, /23505/, "expected a unique violation (23505)");
        assert.match(
          haystack,
          /observations_single_root_idx/,
          "expected the single-root index to reject the second root",
        );
        return true;
      },
    );
  });

  test("recordEntityIdentity is idempotent over the active (kind, value) set", async () => {
    const userId = await seedUser();
    const entityId = await seedNode(userId, "person@example.com");

    const a = await recordEntityIdentity({
      userId,
      entityId,
      identity: { kind: "email", value: "person@example.com" },
      source: "gmail",
      validFrom: SEED_FIRST_SEEN_AT,
    });
    const b = await recordEntityIdentity({
      userId,
      entityId,
      identity: { kind: "email", value: "person@example.com" },
      source: "gmail",
      validFrom: SEED_FIRST_SEEN_AT,
    });
    assert.equal(a.id, b.id, "a repeat link returns the same live identity row");
  });

  test("recordEntityIdentity surfaces a cross-entity collision instead of swallowing it", async () => {
    const userId = await seedUser();
    const entityA = await seedNode(userId, "node-a@example.com");
    const entityB = await seedNode(userId, "node-b@example.com");
    const shared = { kind: "email" as const, value: "shared@example.com" };

    // The handle binds to A first.
    await recordEntityIdentity({
      userId,
      entityId: entityA,
      identity: shared,
      source: "gmail",
      validFrom: SEED_FIRST_SEEN_AT,
    });

    // Asking to bind the SAME live (kind, value) to a different node must NOT
    // silently hand back A's row as if B's link succeeded — it is the merge/
    // re-anchor signal, surfaced as a typed conflict for the reducer.
    await assert.rejects(
      () =>
        recordEntityIdentity({
          userId,
          entityId: entityB,
          identity: shared,
          source: "gmail",
          validFrom: SEED_FIRST_SEEN_AT,
        }),
      (err: unknown) => {
        assert.ok(err instanceof EntityIdentityConflictError, "expected a typed conflict");
        assert.equal(err.liveEntityId, entityA);
        assert.equal(err.requestedEntityId, entityB);
        assert.equal(err.value, "shared@example.com");
        return true;
      },
    );
  });

  test("ensureEntityNode converges firstSeenAt to the earliest observation regardless of replay order", async () => {
    seedServerEnvForStableIds();
    const userId = await seedUser();
    const identity = { kind: "email" as const, value: "ordered@example.com" };

    const newer = await ensureEntityNode({
      userId,
      identity,
      firstSeenAt: new Date("2026-06-23T12:00:00.000Z"),
    });
    const older = await ensureEntityNode({
      userId,
      identity,
      firstSeenAt: new Date("2026-06-22T12:00:00.000Z"),
    });

    assert.equal(older.id, newer.id, "same identity reuses the same stable node");
    assert.equal(
      older.firstSeenAt.toISOString(),
      "2026-06-22T12:00:00.000Z",
      "an older observation arriving later pulls firstSeenAt down to the minimum",
    );
  });

  test("projection run is single-attempt and completion requires a checksum", async () => {
    const userId = await seedUser();
    const started = await startProjectionRun({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
    });
    assert.equal(started.reused, false);

    const again = await startProjectionRun({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
    });
    assert.equal(again.reused, true);
    assert.equal(again.run.id, started.run.id);

    await assert.rejects(
      () =>
        completeProjectionRun({
          runId: started.run.id,
          userId,
          checksum: "   ",
          completedAt: new Date(),
        }),
      /non-empty checksum/,
    );
  });

  test("activateProjectionVersion refuses a running run and accepts a completed one", async () => {
    const userId = await seedUser();
    const { run } = await startProjectionRun({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
    });

    await assert.rejects(
      () =>
        activateProjectionVersion({
          userId,
          projectionName: USER_MODEL_PROJECTION_NAME,
          runId: run.id,
        }),
      /not 'completed'/,
    );

    await completeProjectionRun({
      runId: run.id,
      userId,
      checksum: "checksum-v1",
      completedAt: new Date("2026-06-23T01:00:00.000Z"),
    });
    const pointer = await activateProjectionVersion({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      runId: run.id,
    });
    assert.equal(pointer.activeRunId, run.id);
    assert.equal(pointer.activeVersion, 1);
  });

  test("a completed run is terminal: re-completing and failing-after-complete are both rejected", async () => {
    const userId = await seedUser();
    const { run } = await startProjectionRun({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
    });
    await completeProjectionRun({
      runId: run.id,
      userId,
      checksum: "checksum-original",
      completedAt: new Date("2026-06-23T01:00:00.000Z"),
    });

    // A second completion must NOT overwrite the trusted checksum/completedAt.
    await assert.rejects(
      () =>
        completeProjectionRun({
          runId: run.id,
          userId,
          checksum: "checksum-tampered",
          completedAt: new Date("2026-06-24T01:00:00.000Z"),
        }),
      /already completed/,
    );

    // Demoting a completed run to failed would orphan the cutover invariant.
    await assert.rejects(
      () => failProjectionRun({ runId: run.id, userId }),
      /already.*completed|cannot be demoted/,
    );

    // The original completion is intact.
    const [after] = await db().select().from(projectionRuns).where(eq(projectionRuns.id, run.id));
    assert.equal(after?.status, "completed");
    assert.equal(after?.checksum, "checksum-original");
  });

  test("writeProjectionCursor writes while running and is rejected once completed", async () => {
    const userId = await seedUser();
    const { run } = await startProjectionRun({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
    });

    // While running: the cursor write lands.
    await writeProjectionCursor({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      projectionVersion: 1,
      projectionRunId: run.id,
      source: "gmail",
      cursor: { lastObservationId: "obs_1" },
    });
    const [cursor] = await db()
      .select()
      .from(projectionCursors)
      .where(
        and(
          eq(projectionCursors.userId, userId),
          eq(projectionCursors.projectionRunId, run.id),
          eq(projectionCursors.source, "gmail"),
        ),
      );
    assert.equal(cursor?.cursor.lastObservationId, "obs_1");

    await completeProjectionRun({
      runId: run.id,
      userId,
      checksum: "checksum-v1",
      completedAt: new Date("2026-06-23T01:00:00.000Z"),
    });

    // After completion the replay record is immutable — no more cursor writes.
    await assert.rejects(
      () =>
        writeProjectionCursor({
          userId,
          projectionName: USER_MODEL_PROJECTION_NAME,
          projectionVersion: 1,
          projectionRunId: run.id,
          source: "gmail",
          cursor: { lastObservationId: "obs_2" },
        }),
      /not 'running'|immutable replay record/,
    );
  });

  test("userModelReader returns empty until activated, then pins to the active run", async () => {
    const userId = await seedUser();
    const entityId = await seedNode(userId, "reader@example.com");
    const reader = userModelReader(userId);

    // Nothing activated yet.
    assert.equal(await reader.getActivePointer(), null);
    assert.deepEqual(await reader.listProfiles(), []);

    // Two completed versions; only v1 is activated.
    const seedProfileVersion = async (version: number) => {
      const { run } = await startProjectionRun({
        userId,
        projectionName: USER_MODEL_PROJECTION_NAME,
        projectionVersion: version,
      });
      await db()
        .insert(entityProfiles)
        .values({
          userId,
          projectionName: USER_MODEL_PROJECTION_NAME,
          projectionVersion: version,
          projectionRunId: run.id,
          entityId,
          displayName: `v${version}`,
          kind: "person",
        });
      await completeProjectionRun({
        runId: run.id,
        userId,
        checksum: `checksum-v${version}`,
        completedAt: new Date("2026-06-23T01:00:00.000Z"),
      });
      return run.id;
    };
    const runV1 = await seedProfileVersion(1);
    await seedProfileVersion(2);

    await activateProjectionVersion({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      runId: runV1,
    });

    const profiles = await reader.listProfiles();
    assert.equal(profiles.length, 1, "reader returns only the active version's rows");
    assert.equal(profiles[0]?.displayName, "v1");
    assert.equal(profiles[0]?.projectionRunId, runV1);

    const byId = await reader.getProfile(entityId);
    assert.equal(byId?.displayName, "v1");

    // Now flip the pointer to v2 and confirm the read follows.
    const [v2run] = await db()
      .select()
      .from(projectionRuns)
      .where(
        and(
          eq(projectionRuns.userId, userId),
          eq(projectionRuns.projectionName, USER_MODEL_PROJECTION_NAME),
          eq(projectionRuns.projectionVersion, 2),
        ),
      );
    assert.ok(v2run);
    await activateProjectionVersion({
      userId,
      projectionName: USER_MODEL_PROJECTION_NAME,
      runId: v2run.id,
    });
    const afterFlip = await reader.listProfiles();
    assert.equal(afterFlip[0]?.displayName, "v2");

    const pointer = await db()
      .select()
      .from(activeProjectionVersions)
      .where(eq(activeProjectionVersions.userId, userId));
    assert.equal(pointer.length, 1, "active pointer is one row per (user, projection)");
  });
});

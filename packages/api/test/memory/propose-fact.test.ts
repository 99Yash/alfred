import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { user, userFacts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import { proposeFact, recallActiveByKey } from "../../src/modules/memory/facts";

/**
 * DB-backed integration test for `proposeFact`'s #330 capture invariants:
 *   - canonicalize alias keys (all sources) before storing;
 *   - reject unknown / not_writable / bad-value-shape on the document path only;
 *   - persist unknown keys as-is for trusted (non-document) sources;
 *   - source-agnostic single-valued conflict → hold `proposed` (autonomous) or
 *     supersede (user-driven).
 *
 * Opt-in: runs only with a reachable migrated `DATABASE_URL`. Seeds throwaway
 * `test-pf-*` users and deletes them on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-pf-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function activeRows(userId: string, key: string) {
  return db()
    .select({
      id: userFacts.id,
      key: userFacts.key,
      value: userFacts.value,
      status: userFacts.status,
      source: userFacts.source,
    })
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), eq(userFacts.key, key)));
}

describe("proposeFact capture invariants (DB-backed, #330)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("canonicalizes an alias key (document) and records originalKey", async () => {
    const userId = await seedUser();
    const fact = await proposeFact({
      userId,
      key: "current_company",
      value: "Oliv AI",
      confidence: 0.95,
      source: { kind: "document", id: "doc_1" },
    });
    assert.ok(fact, "alias key should persist under the canonical key");
    assert.equal(fact.key, "employer");
    assert.equal((fact.source.meta as { originalKey?: string })?.originalKey, "current_company");
    // Nothing stored under the alias spelling.
    assert.equal((await activeRows(userId, "current_company")).length, 0);
  });

  test("rejects unknown / not_writable / bad value on the document path", async () => {
    const userId = await seedUser();
    assert.equal(
      await proposeFact({
        userId,
        key: "zoom_passcode",
        value: "1234",
        confidence: 0.99,
        source: { kind: "document", id: "d" },
      }),
      null,
      "unknown document key rejected",
    );
    assert.equal(
      await proposeFact({
        userId,
        key: "pref:tone",
        value: "warm",
        confidence: 0.99,
        source: { kind: "document", id: "d" },
      }),
      null,
      "pref:* is not document-writable",
    );
    assert.equal(
      await proposeFact({
        userId,
        key: "phone_number",
        value: "+15551234",
        confidence: 0.99,
        source: { kind: "document", id: "d" },
      }),
      null,
      "phone_number is not document-writable",
    );
    assert.equal(
      await proposeFact({
        userId,
        key: "employer",
        value: 42,
        confidence: 0.99,
        source: { kind: "document", id: "d" },
      }),
      null,
      "non-string identity value rejected",
    );
  });

  test("persists an unknown key as-is for a trusted (non-document) source", async () => {
    const userId = await seedUser();
    const fact = await proposeFact({
      userId,
      key: "custom_curated_key",
      value: "kept",
      confidence: 0.99,
      source: { kind: "user" },
    });
    assert.ok(fact, "non-document unknown key should persist as-is");
    assert.equal(fact.key, "custom_curated_key");
  });

  test("single-valued conflict from an autonomous source is held as proposed", async () => {
    const userId = await seedUser();
    const truth = await proposeFact({
      userId,
      key: "employer",
      value: "Oliv AI",
      confidence: 1,
      source: { kind: "user" },
    });
    assert.equal(truth?.status, "confirmed");

    const conflict = await proposeFact({
      userId,
      key: "employer",
      value: "AirBills",
      confidence: 0.99, // would normally auto-confirm
      source: { kind: "document", id: "doc_leak" },
    });
    assert.equal(conflict?.status, "proposed", "a leaked conflicting value must NOT auto-confirm");

    // The authoritative value is still the single active confirmed one.
    const confirmed = (await activeRows(userId, "employer")).filter(
      (r) => r.status === "confirmed",
    );
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0]?.value, "Oliv AI");
  });

  test("single-valued conflict from the user supersedes the prior value", async () => {
    const userId = await seedUser();
    await proposeFact({
      userId,
      key: "employer",
      value: "Oliv AI",
      confidence: 1,
      source: { kind: "user" },
    });
    const moved = await proposeFact({
      userId,
      key: "employer",
      value: "NewCo",
      confidence: 1,
      source: { kind: "user" },
    });
    assert.equal(moved?.status, "confirmed");
    const confirmed = (await activeRows(userId, "employer")).filter(
      (r) => r.status === "confirmed",
    );
    assert.equal(confirmed.length, 1, "exactly one active confirmed value after a user move");
    assert.equal(confirmed[0]?.value, "NewCo");
    // Recall returns the single authoritative value.
    const recalled = await recallActiveByKey(userId, "employer");
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.value, "NewCo");
  });
});

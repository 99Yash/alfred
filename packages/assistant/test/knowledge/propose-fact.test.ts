import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import type { ClaimProvenance } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user, userFacts } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";

import {
  claimProducer,
  confirmFact,
  proposeFact,
  recallActiveByKey,
} from "@alfred/assistant/knowledge";
import { closeRedis } from "@alfred/db/redis";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `proposeFact` capture rules. Needs a migrated `DATABASE_URL`. Every claim canonicalizes alias keys.
 * Only the document path rejects unknown or non-writable keys and bad values.
 * An agent claim is `proposed`; a user claim is `confirmed` and supersedes a single-valued conflict.
 */
const SKIP = dbBackedSkip("database");

const PRODUCER = claimProducer({ pipeline: "test" });

/** An agent claim from a mail: the document write policy applies. */
function fromDocument(id: string): ClaimProvenance {
  return { author: "agent", evidence: [{ kind: "document", id }], producer: PRODUCER };
}

/** An agent claim from an observation: no document policy. */
const FROM_AGENT: ClaimProvenance = {
  author: "agent",
  evidence: [{ kind: "observation", id: "obs_1" }],
  producer: PRODUCER,
};

/** The user's own claim. */
const FROM_USER: ClaimProvenance = {
  author: "user",
  evidence: [{ kind: "chat_message", id: "msg_1" }],
  producer: PRODUCER,
};

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
      author: userFacts.author,
    })
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), eq(userFacts.key, key)));
}

describe("proposeFact capture invariants (DB-backed, #330)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    // Fact capture opens a Redis connection; an open one keeps the test process alive.
    await closeRedis();
    await closeConnections();
  });

  test("canonicalizes an alias key (document)", async () => {
    const userId = await seedUser();

    const fact = await proposeFact({
      userId,
      key: "current_company",
      value: "Oliv AI",
      confidence: 0.95,
      ...fromDocument("doc_1"),
    });

    assert.ok(fact, "alias key should persist under the canonical key");
    assert.equal(fact.key, "employer");
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
        ...fromDocument("d"),
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
        ...fromDocument("d"),
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
        ...fromDocument("d"),
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
        ...fromDocument("d"),
      }),
      null,
      "non-string identity value rejected",
    );
  });

  test("relationship junk floor rejects service-sender + empty edges for ALL sources (#492)", async () => {
    const userId = await seedUser();

    // A service sender is never a relationship, even from a trusted source with a plausible role.
    assert.equal(
      await proposeFact({
        userId,
        key: "relationship:help@sentry.io",
        value: { role: "vendor" },
        confidence: 0.99,
        ...FROM_AGENT,
      }),
      null,
      "service-sender relationship rejected for a non-document source",
    );

    // An empty/uninformative relationship value is rejected for all sources.
    assert.equal(
      await proposeFact({
        userId,
        key: "relationship:alice@oliv.ai",
        value: {},
        confidence: 0.99,
        ...FROM_AGENT,
      }),
      null,
      "empty relationship value rejected for a non-document source",
    );

    // A genuine relationship to a real person, with a concrete role, still lands.
    const good = await proposeFact({
      userId,
      key: "relationship:alice@oliv.ai",
      value: { role: "manager" },
      confidence: 0.99,
      ...FROM_AGENT,
    });

    assert.ok(good, "a genuine relationship to a real person persists");
    assert.equal(good.key, "relationship:alice@oliv.ai");

    // Nothing was persisted under the rejected service-sender edge.
    assert.equal((await activeRows(userId, "relationship:help@sentry.io")).length, 0);
  });

  test("persists an unknown key as-is for a trusted (non-document) source", async () => {
    const userId = await seedUser();

    const fact = await proposeFact({
      userId,
      key: "custom_curated_key",
      value: "kept",
      confidence: 0.99,
      ...FROM_USER,
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
      ...FROM_USER,
    });

    assert.equal(truth?.status, "confirmed");

    const conflict = await proposeFact({
      userId,
      key: "employer",
      value: "AirBills",
      confidence: 0.99,
      ...fromDocument("doc_leak"),
    });

    assert.equal(conflict?.status, "proposed", "an agent claim is never confirmed at write");

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
      ...FROM_USER,
    });

    const moved = await proposeFact({
      userId,
      key: "employer",
      value: "NewCo",
      confidence: 1,
      ...FROM_USER,
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

  test("confirming a held single-valued conflict supersedes the prior confirmed value", async () => {
    const userId = await seedUser();

    const truth = await proposeFact({
      userId,
      key: "employer",
      value: "Oliv AI",
      confidence: 1,
      ...FROM_USER,
    });

    assert.equal(truth?.status, "confirmed");

    const conflict = await proposeFact({
      userId,
      key: "employer",
      value: "NewCo",
      confidence: 0.99,
      ...fromDocument("doc_claim"),
    });

    assert.equal(conflict?.status, "proposed");

    const confirmedConflict = await confirmFact({ factId: conflict.id, userId, exec: "own" });
    assert.equal(confirmedConflict?.status, "confirmed");
    assert.equal(confirmedConflict.supersedesId, truth.id);

    const rows = await activeRows(userId, "employer");
    const confirmed = rows.filter((r) => r.status === "confirmed");
    const superseded = rows.filter((r) => r.status === "superseded");
    assert.equal(confirmed.length, 1, "confirming a conflict must not leave two active truths");
    assert.equal(confirmed[0]?.value, "NewCo");
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0]?.value, "Oliv AI");
  });
});

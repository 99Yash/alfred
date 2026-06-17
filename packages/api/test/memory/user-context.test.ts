import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { entities, user } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { readUserContext } from "../../src/modules/memory/user-context";

/**
 * DB-backed integration test for the two behaviors the PR review flagged on
 * `readUserContext`:
 *   1. entities are ranked by the significance scalar (ADR-0057), NOT
 *      alphabetically, with unscored rows last — so the bounded slice keeps
 *      who-matters;
 *   2. a `subjectEmail` / `query` focus pulls a low-significance contact in
 *      even when it falls below the ranked cap, so a targeted lookup never
 *      silently misses its subject.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable Postgres with the
 * migrated schema (the local dev DB). Skipped otherwise so the pure-function
 * suite still runs in environments without a database. It seeds throwaway
 * `test-uctx-*` users and deletes them (cascade clears their entities) on teardown.
 */
const SKIP = process.env.DATABASE_URL ? false : "DATABASE_URL not set — skipping DB-backed test";

const ID_PREFIX = "test-uctx-";
const createdUserIds: string[] = [];

function freshUserId(): string {
  const id = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

async function seedUser(): Promise<string> {
  const userId = freshUserId();
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

interface SeedEntity {
  name: string;
  /** `metadata.significance.score`; `null` leaves the row unscored. */
  score: number | null;
  aliases?: string[];
}

async function seedEntities(userId: string, specs: SeedEntity[]): Promise<void> {
  await db()
    .insert(entities)
    .values(
      specs.map((spec) => ({
        userId,
        kind: "person",
        canonicalName: spec.name,
        aliases: spec.aliases ?? [],
        metadata: spec.score === null ? {} : { significance: { score: spec.score } },
      })),
    );
}

describe("readUserContext (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    // Clear any rows a previously-crashed run left behind.
    await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("ranks entities by significance (unscored last), not alphabetically", async () => {
    const userId = await seedUser();
    // Names are in the REVERSE of significance order, so an alphabetical sort
    // would invert the expected result.
    await seedEntities(userId, [
      { name: "Aaron Aardvark", score: 0.1 },
      { name: "Mallory Mid", score: 0.5 },
      { name: "Zoe Zenith", score: 0.9 },
      { name: "Uma Unscored", score: null },
    ]);

    const ctx = await readUserContext(userId);
    const order = ctx.entities.map((e) => e.canonicalName);

    assert.deepEqual(
      order,
      ["Zoe Zenith", "Mallory Mid", "Aaron Aardvark", "Uma Unscored"],
      "entities should be significance-desc with the unscored row last",
    );
    // Guard against a regression to the old alphabetical ordering.
    assert.notEqual(order[0], "Aaron Aardvark", "must not be ordered alphabetically");
  });

  test("guarantees a focused contact (subjectEmail / query) past the ranked cap", async () => {
    const userId = await seedUser();
    // Fill the entire ranked cap (ENTITY_LIMIT = 50) with high-significance
    // contacts, then add ONE low-significance subject that ranks 51st and would
    // be truncated out of the ranked slice.
    const fillers: SeedEntity[] = Array.from({ length: 50 }, (_, i) => ({
      name: `Filler ${String(i).padStart(2, "0")}`,
      score: 0.9,
    }));
    await seedEntities(userId, [
      ...fillers,
      { name: "Subject Person", score: 0.01, aliases: ["subject@example.com"] },
    ]);

    const hasSubject = (ctx: Awaited<ReturnType<typeof readUserContext>>): boolean =>
      ctx.entities.some((e) => e.canonicalName === "Subject Person");

    // Baseline: the subject is below the cap, so a plain read drops it.
    const plain = await readUserContext(userId);
    assert.equal(plain.entities.length, 50, "ranked slice is capped at ENTITY_LIMIT");
    assert.equal(hasSubject(plain), false, "low-significance subject is truncated without a focus");

    // subjectEmail (case-insensitive alias match) rescues it.
    const byEmail = await readUserContext(userId, { subjectEmail: "Subject@Example.com" });
    assert.equal(hasSubject(byEmail), true, "subjectEmail must guarantee the contact is included");

    // A free-text query that hits the name does too.
    const byQuery = await readUserContext(userId, { query: "subject person" });
    assert.equal(hasSubject(byQuery), true, "a name-matching query must guarantee inclusion");
  });
});

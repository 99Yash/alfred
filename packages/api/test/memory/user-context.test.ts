import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { entities, user, userFacts } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { readUserContext } from "../../src/modules/memory/user-context";

/**
 * DB-backed integration test for `readUserContext`'s bounded-slice behaviors:
 *   1. entities are ranked by the significance scalar (ADR-0057), NOT
 *      alphabetically, with unscored rows last — so the bounded slice keeps
 *      who-matters;
 *   2. a `subjectEmail` / `query` focus pulls a low-significance contact in
 *      even when it falls below the ranked cap, so a targeted lookup never
 *      silently misses its subject;
 *   3. confirmed facts rank by confidence before recency, and canonical
 *      identity facts are guaranteed into the slice so transactional per-email
 *      noise can never evict the user's authoritative identity (issue #329).
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

interface SeedFact {
  key: string;
  value: unknown;
  confidence: number;
  /** Lower = older. Drives recency ordering within the same confidence. */
  ageMinutes: number;
      source?: { kind: "document" | "user" | "cold_start" | "agent"; meta?: Record<string, unknown> };
}

async function seedFacts(userId: string, specs: SeedFact[]): Promise<void> {
  const base = Date.now();
  await db()
    .insert(userFacts)
    .values(
      specs.map((spec) => {
        const ts = new Date(base - spec.ageMinutes * 60_000);
        return {
          userId,
          key: spec.key,
          value: spec.value,
          confidence: spec.confidence,
          status: "confirmed" as const,
          source: spec.source ?? { kind: "document" as const },
          createdAt: ts,
          updatedAt: ts,
        };
      }),
    );
}

describe("readUserContext (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    // Clear any rows a previously-crashed run left behind.
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

  test("guarantees canonical identity facts survive a flood of recent noise (issue #329)", async () => {
    const userId = await seedUser();
    // Fill the ENTIRE fact cap (FACT_LIMIT = 30) with the most-recent, top-
    // confidence transactional noise, so identity is BOTH less recent AND no
    // more confident than every row competing for the slice — the worst case
    // that recency-only ordering (the bug) and confidence-only ordering both
    // fail to rescue. Only the identity whitelist can.
    const noise: SeedFact[] = Array.from({ length: 30 }, (_, i) => ({
      key: `txn_field_${String(i).padStart(2, "0")}`,
      value: `noise-${i}`,
      confidence: 1.0,
      ageMinutes: i + 1, // all newer than the identity fact below
    }));
    await seedFacts(userId, [
      ...noise,
      // Authoritative identity, older and same confidence → ranks ~#31 by
      // recency and would be evicted from the bounded slice without the guard.
      // Canonical storage key is `employer` (#330); `current_company` is a read DTO label.
      { key: "employer", value: "Oliv AI", confidence: 1.0, ageMinutes: 10_000 },
    ]);

    const ctx = await readUserContext(userId);
    const company = ctx.confirmedFacts.find((f) => f.key === "employer");
    assert.ok(company, "employer must survive the cap even when buried by recent noise");
    assert.equal(company.value, "Oliv AI");
    assert.equal(ctx.confirmedFacts.length, 30, "merged fact slice stays bounded at FACT_LIMIT");
  });

  test("surfaces identity in profile even when facts are omitted (issue #329)", async () => {
    const userId = await seedUser();
    await seedFacts(userId, [
      {
        key: "employer",
        value: "Oliv AI",
        confidence: 1.0,
        ageMinutes: 10,
        source: { kind: "user" },
      },
      {
        key: "work_summary",
        value: "building Alfred",
        confidence: 1.0,
        ageMinutes: 9,
        source: { kind: "user" },
      },
      {
        key: "bio_summary",
        value: "Yash works on Alfred at Oliv AI",
        confidence: 1.0,
        ageMinutes: 8,
        source: { kind: "user" },
      },
    ]);

    const ctx = await readUserContext(userId, { include: ["profile", "integrations"] });

    assert.equal(ctx.confirmedFacts.length, 0, "facts section stays omitted when not requested");
    // Canonical storage keys (`employer`/`work_summary`) map to the stable DTO
    // field names (`currentCompany`/`currentWork`) — #330 read-side convergence.
    assert.equal(ctx.profile?.currentCompany, "Oliv AI");
    assert.equal(ctx.profile?.currentWork, "building Alfred");
    assert.equal(ctx.profile?.bioSummary, "Yash works on Alfred at Oliv AI");
  });

  test("profile identity prefers trusted user facts over newer document noise", async () => {
    const userId = await seedUser();
    await seedFacts(userId, [
      {
        key: "employer",
        value: "AirBills",
        confidence: 1.0,
        ageMinutes: 1,
        source: { kind: "document" },
      },
      {
        key: "job_title",
        value: { title: "not a string" },
        confidence: 1.0,
        ageMinutes: 1,
        source: { kind: "user" },
      },
      {
        key: "job_title",
        value: "Software Engineer",
        confidence: 0.95,
        ageMinutes: 20,
        source: { kind: "user" },
      },
      {
        key: "employer",
        value: "Oliv AI",
        confidence: 1.0,
        ageMinutes: 10_000,
        source: { kind: "user" },
      },
    ]);

    const ctx = await readUserContext(userId);

    assert.equal(ctx.profile?.currentCompany, "Oliv AI");
    assert.equal(ctx.profile?.currentRole, "Software Engineer");
    assert.deepEqual(
      ctx.profile?.identityFacts.map((fact) => fact.key),
      ["employer", "job_title"],
    );
    assert.ok(
      ctx.confirmedFacts.some((fact) => fact.key === "employer"),
      "per-key identity rescue must include employer despite newer document noise",
    );
  });

  test("profile accepts document identity only when the workflow marked authorship", async () => {
    const userId = await seedUser();
    await seedFacts(userId, [
      {
        key: "location",
        value: "Wrong City",
        confidence: 1.0,
        ageMinutes: 1,
        source: { kind: "document" },
      },
      {
        key: "location",
        value: "Bengaluru",
        confidence: 0.95,
        ageMinutes: 20,
        source: { kind: "document", meta: { documentAuthoredByUser: true } },
      },
    ]);

    const ctx = await readUserContext(userId, { include: ["profile"] });

    assert.equal(ctx.profile?.currentLocation, "Bengaluru");
  });

  test("orders confirmed facts by confidence before recency", async () => {
    const userId = await seedUser();
    await seedFacts(userId, [
      // Recent but low confidence — must NOT outrank the older, high-confidence fact.
      { key: "rumor", value: "maybe", confidence: 0.86, ageMinutes: 1 },
      { key: "settled", value: "yes", confidence: 0.99, ageMinutes: 500 },
    ]);

    const ctx = await readUserContext(userId);
    const keys = ctx.confirmedFacts.map((f) => f.key);
    assert.deepEqual(
      keys,
      ["settled", "rumor"],
      "higher-confidence fact ranks first despite being older",
    );
  });
});

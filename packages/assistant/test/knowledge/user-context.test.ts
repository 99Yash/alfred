import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { entities, memoryChunks, user, userFacts } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import { readUserContext } from "@alfred/assistant/knowledge";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `readUserContext` bounded slice. Needs a migrated `DATABASE_URL`.
 * Entities rank by significance (ADR-0057), unscored last. A focused lookup pulls in
 * its subject below the cap. Identity facts always fit, so per-email noise cannot evict them.
 */
const SKIP = dbBackedSkip("database");

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

/** Insert memory chunks directly; `recent_memory` orders by `createdAt`, so no embedding is needed. */
async function seedMemoryChunks(
  userId: string,
  specs: Array<{ kind: string; content: string }>,
): Promise<void> {
  await db()
    .insert(memoryChunks)
    .values(
      specs.map((spec) => ({
        userId,
        kind: spec.kind,
        content: spec.content,
        contentHash: createHash("sha256").update(spec.content).digest("hex"),
      })),
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
    // Names run opposite to significance, so an alphabetical sort fails.
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
    assert.notEqual(order[0], "Aaron Aardvark", "must not be ordered alphabetically");
  });

  test("guarantees a focused contact (subjectEmail / query) past the ranked cap", async () => {
    const userId = await seedUser();

    // Fill the cap (ENTITY_LIMIT = 50) with high-significance contacts; the subject ranks 51st.
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

    // Fill the cap (FACT_LIMIT = 30) with newer, equally confident noise.
    // Neither recency nor confidence ordering can save identity; only the whitelist can.
    const noise: SeedFact[] = Array.from({ length: 30 }, (_, i) => ({
      key: `txn_field_${String(i).padStart(2, "0")}`,
      value: `noise-${i}`,
      confidence: 1.0,
      ageMinutes: i + 1, // all newer than the identity fact below
    }));

    await seedFacts(userId, [
      ...noise,
      // Ranks about 31st by recency. The storage key is `employer`; `current_company` is a read label.
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
    // Storage keys `employer`/`work_summary` map to DTO fields `currentCompany`/`currentWork`.
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
      // Recent but low confidence: must not outrank the older, confident fact.
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

  test("recent_memory excludes operational extraction_run telemetry (#1052)", async () => {
    const userId = await seedUser();
    await seedMemoryChunks(userId, [
      {
        kind: "extraction_run",
        content: "Memory-extraction run run_x: processed 20 document(s); proposed 0 fact(s).",
      },
      { kind: "thread_summary", content: "The user prefers dark mode." },
    ]);

    const ctx = await readUserContext(userId, { include: ["recent_memory"] });

    assert.deepEqual(
      ctx.recentMemory.map((chunk) => chunk.kind),
      ["thread_summary"],
      "recent_memory must not surface operational extraction_run telemetry",
    );
  });
});

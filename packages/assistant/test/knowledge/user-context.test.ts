import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { memoryChunks, user, userFacts } from "@alfred/db/schemas";
import { inArray, like } from "drizzle-orm";

import {
  appendObservationFamilyMember,
  readUserContext,
  reduceGmailDocument,
} from "@alfred/assistant/knowledge";
import { dbBackedSkip } from "../support/db-backed";

/**
 * `readUserContext` bounded slice. Needs a migrated `DATABASE_URL`.
 * The people section ranks the recently mailed addresses, or reads a focus. Identity facts
 * always fit, so per-email noise cannot evict them.
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

/** Put a sent Gmail message through the production activity writer. */
async function seedSentMail(
  userId: string,
  recipients: ReadonlyArray<{ name: string; address: string; sentAt: Date }>,
): Promise<void> {
  const observations = recipients.flatMap(({ name, address, sentAt }, index) => {
    const id = `mail-${index}`;

    return reduceGmailDocument({
      id,
      userId,
      raw: null,
      metadata: { from: `${userId}@example.test`, to: `${name} <${address}>`, isSent: true },
      sourceId: id,
      sourceThreadId: null,
      title: null,
      accountId: null,
      authoredAt: sentAt,
    }).observations;
  });

  await Promise.all(observations.map((observation) => appendObservationFamilyMember(observation)));
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

  test("ranks people by the last sent mail", async () => {
    const userId = await seedUser();
    await seedSentMail(userId, [
      { name: "Aaron Aardvark", address: "aaron@example.test", sentAt: new Date("2026-09-05") },
      { name: "Mallory Mid", address: "mallory@example.test", sentAt: new Date("2026-09-06") },
      { name: "Zoe Zenith", address: "zoe@example.test", sentAt: new Date("2026-09-07") },
    ]);

    const ctx = await readUserContext(userId);

    assert.deepEqual(
      ctx.people.map((person) => person.address),
      ["zoe@example.test", "mallory@example.test", "aaron@example.test"],
    );
  });

  test("guarantees a focused address past the recent mail cap", async () => {
    const userId = await seedUser();

    const fillers = Array.from({ length: 20 }, (_, i) => ({
      name: `Filler ${i}`,
      address: `filler-${i}@example.test`,
      sentAt: new Date("2026-09-06"),
    }));

    await seedSentMail(userId, [
      ...fillers,
      { name: "Subject Person", address: "subject@example.test", sentAt: new Date("2026-09-05") },
    ]);

    const addresses = (ctx: Awaited<ReturnType<typeof readUserContext>>): string[] =>
      ctx.people.map((person) => person.address);

    const plain = await readUserContext(userId);
    assert.equal(plain.people.length, 20);
    assert.equal(addresses(plain).includes("subject@example.test"), false);

    const byEmail = await readUserContext(userId, { subjectEmail: "Subject@Example.test" });
    assert.deepEqual(addresses(byEmail), ["subject@example.test"]);

    const byQuery = await readUserContext(userId, { query: "subject person" });
    assert.deepEqual(addresses(byQuery), ["subject@example.test"]);
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
    assert.equal(ctx.profile.currentCompany, "Oliv AI");
    assert.equal(ctx.profile.currentWork, "building Alfred");
    assert.equal(ctx.profile.bioSummary, "Yash works on Alfred at Oliv AI");
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

    assert.equal(ctx.profile.currentCompany, "Oliv AI");
    assert.equal(ctx.profile.currentRole, "Software Engineer");
    assert.deepEqual(
      ctx.profile.identityFacts.map((fact) => fact.key),
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

    assert.equal(ctx.profile.currentLocation, "Bengaluru");
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

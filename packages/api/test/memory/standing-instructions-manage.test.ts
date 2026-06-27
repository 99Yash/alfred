import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import {
  STANDING_INSTRUCTION_KEY,
  STANDING_INSTRUCTION_SCHEMA_VERSION,
  SUPPRESSION_EFFECTS,
  standingInstructionValueSchema,
} from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { observations, user, userFacts } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq, inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import {
  editStandingInstruction,
  forgetStandingInstruction,
  listStandingInstructions,
  rememberSenderSuppression,
} from "../../src/modules/memory/standing-instructions";
import { closeRedis } from "../../src/queue/connection";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-standing-manage-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Manage Test User", email: `${userId}@example.test` });
  return userId;
}

async function remember(userId: string, email: string, label: string): Promise<string> {
  const result = await rememberSenderSuppression({
    userId,
    senderEmail: email,
    senderLabel: label,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.factId;
}

function instructionValue(email: string, label: string) {
  return standingInstructionValueSchema.parse({
    schemaVersion: STANDING_INSTRUCTION_SCHEMA_VERSION,
    action: "suppress",
    surface: "open_loop",
    target: {
      kind: "sender_email",
      email,
      label,
      accountId: null,
    },
    effects: [...SUPPRESSION_EFFECTS],
    directive: `Stop surfacing reminders and briefing items from ${label}.`,
    phrasing: `stop surfacing ${label}`,
  });
}

describe("standing instruction management (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeReplicachePokeBridge();
    await closeRedis();
    await closeConnections();
  });

  test("list returns active instructions with their factIds", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "noisy@example.com", "Noisy Sender");

    const instructions = await listStandingInstructions(userId);
    assert.equal(instructions.length, 1);
    assert.equal(instructions[0]?.factId, factId);
    assert.equal(instructions[0]?.target.email, "noisy@example.com");
    assert.deepEqual([...instructions[0].effects].sort(), [...SUPPRESSION_EFFECTS].sort());
  });

  test("list returns every active instruction instead of truncating at an arbitrary cap", async () => {
    const userId = await seedUser();
    await db()
      .insert(userFacts)
      .values(
        Array.from({ length: 201 }, (_, i) => ({
          userId,
          key: STANDING_INSTRUCTION_KEY,
          value: instructionValue(`sender-${i}@example.com`, `Sender ${i}`),
          confidence: 1,
          status: "confirmed",
          source: { kind: "user" },
          validFrom: new Date(Date.UTC(2026, 0, 1, 0, i)),
          validUntil: null,
        })),
      );

    const instructions = await listStandingInstructions(userId);
    assert.equal(instructions.length, 201);
    assert.ok(instructions.some((i) => i.target.email === "sender-0@example.com"));
    assert.ok(instructions.some((i) => i.target.email === "sender-200@example.com"));
  });

  test("forget soft-removes the instruction so it drops out of the active list", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "drop@example.com", "Drop Me");

    const result = await forgetStandingInstruction({ userId, factId, reason: "user asked" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.status, "forgotten");

    const after = await listStandingInstructions(userId);
    assert.equal(after.length, 0);
  });

  test("forget refuses an already-retired instruction id", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "drop-twice@example.com", "Drop Twice");

    const first = await forgetStandingInstruction({ userId, factId, reason: "user asked" });
    assert.equal(first.ok, true);

    assert.deepEqual(await forgetStandingInstruction({ userId, factId, reason: "again" }), {
      ok: false,
      status: "not_found",
    });
  });

  test("forget refuses an id that isn't this user's standing instruction", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const factId = await remember(owner, "owned@example.com", "Owned");

    // Wrong user can't reach it.
    assert.deepEqual(await forgetStandingInstruction({ userId: stranger, factId }), {
      ok: false,
      status: "not_found",
    });
    // Unknown id is a no-op too.
    assert.deepEqual(await forgetStandingInstruction({ userId: owner, factId: "fact_nope" }), {
      ok: false,
      status: "not_found",
    });
    // The real instruction is untouched.
    assert.equal((await listStandingInstructions(owner)).length, 1);
  });

  test("edit supersedes the row, keeping exactly one active instruction with the new wording", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "reframe@example.com", "Old Label");

    const result = await editStandingInstruction({
      userId,
      factId,
      directive: "Quietly ignore the reframed sender.",
      senderLabel: "New Label",
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "edited");
    assert.notEqual(result.factId, factId);
    assert.equal(result.previousFactId, factId);

    const active = await listStandingInstructions(userId);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.factId, result.factId);
    assert.equal(active[0]?.directive, "Quietly ignore the reframed sender.");
    assert.equal(active[0]?.target.label, "New Label");
    // Target sender is unchanged by a reframe.
    assert.equal(active[0]?.target.email, "reframe@example.com");
  });

  test("management mutations append replayable standing-instruction observations", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "observed@example.com", "Observed Sender");

    const edited = await editStandingInstruction({
      userId,
      factId,
      directive: "Use observed wording.",
    });
    assert.equal(edited.ok, true);
    if (!edited.ok || edited.status !== "edited") throw new Error("unreachable");

    const forgotten = await forgetStandingInstruction({
      userId,
      factId: edited.factId,
      reason: "user asked",
    });
    assert.equal(forgotten.ok, true);

    const rows = await db()
      .select({
        source: observations.source,
        kind: observations.kind,
        payload: observations.payload,
      })
      .from(observations)
      .where(eq(observations.userId, userId));
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.kind === "user_standing_instruction"));
    assert.ok(rows.every((row) => row.source === "user"));

    const operations = rows.map((row) => (row.payload as { operation: string }).operation).sort();
    assert.deepEqual(operations, ["edit", "forget", "remember"]);
  });

  test("edit refuses the stale fact id after it has been superseded", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "stale-edit@example.com", "Stale Edit");

    const first = await editStandingInstruction({
      userId,
      factId,
      directive: "Use this new wording.",
    });
    assert.equal(first.ok, true);
    if (!first.ok || first.status !== "edited") throw new Error("unreachable");

    assert.deepEqual(
      await editStandingInstruction({
        userId,
        factId,
        directive: "This stale edit should not fork the chain.",
      }),
      { ok: false, status: "not_found" },
    );

    const active = await listStandingInstructions(userId);
    assert.equal(active.length, 1);
    assert.equal(active[0]?.factId, first.factId);
    assert.equal(active[0]?.directive, "Use this new wording.");
  });

  test("edit with no effective change returns unchanged without creating a successor", async () => {
    const userId = await seedUser();
    const factId = await remember(userId, "same@example.com", "Same Label");

    const result = await editStandingInstruction({
      userId,
      factId,
      directive: "   ",
      senderLabel: "Same Label",
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.status, "unchanged");
    assert.equal(result.factId, factId);
    assert.equal(result.instruction.target.email, "same@example.com");

    const rows = await db()
      .select({ id: userFacts.id })
      .from(userFacts)
      .where(eq(userFacts.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, factId);
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { SUPPRESSION_EFFECTS } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { user, userFacts } from "@alfred/db/schemas";
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

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isUniqueViolation, uniqueViolationConstraint } from "@alfred/db/pg-errors";

/**
 * Drizzle wraps the pg error, whose `code: "23505"` sits on `.cause`.
 * A top-level-only check made the losing double-submit request return a 500.
 */
describe("isUniqueViolation", () => {
  test("recognizes a raw pg unique violation (code at top level)", () => {
    assert.equal(isUniqueViolation({ code: "23505" }), true);
  });

  test("recognizes a Drizzle-wrapped violation (code on .cause)", () => {
    // Shape of a real DrizzleQueryError wrapping a node-postgres DatabaseError.
    const wrapped = { name: "DrizzleQueryError", cause: { name: "DatabaseError", code: "23505" } };
    assert.equal(isUniqueViolation(wrapped), true);
  });

  test("recognizes a doubly-nested cause", () => {
    assert.equal(isUniqueViolation({ cause: { cause: { code: "23505" } } }), true);
  });

  test("returns false for a different pg error code (raw or wrapped)", () => {
    assert.equal(isUniqueViolation({ code: "23503" }), false); // FK violation
    assert.equal(isUniqueViolation({ cause: { code: "40P01" } }), false); // deadlock
  });

  test("returns false for non-pg errors and nullish", () => {
    assert.equal(isUniqueViolation(new Error("boom")), false);
    assert.equal(isUniqueViolation(null), false);
    assert.equal(isUniqueViolation(undefined), false);
    assert.equal(isUniqueViolation("23505"), false);
  });

  test("terminates on a self-referential cause chain (no infinite loop)", () => {
    // No SQLSTATE: the walk must terminate on the cycle and report false.
    const cyclic = { name: "DatabaseError" };
    Object.assign(cyclic, { cause: cyclic });
    assert.equal(isUniqueViolation(cyclic), false);
  });
});

/** Tells "thread busy" from double-submit by the index on `.constraint`, one level down (#488). */
describe("uniqueViolationConstraint", () => {
  test("returns the constraint name from a raw pg unique violation", () => {
    assert.equal(
      uniqueViolationConstraint({ code: "23505", constraint: "agent_runs_chat_thread_active_idx" }),
      "agent_runs_chat_thread_active_idx",
    );
  });

  test("reads the constraint off a Drizzle-wrapped violation (.cause)", () => {
    const wrapped = {
      name: "DrizzleQueryError",
      cause: { name: "DatabaseError", code: "23505", constraint: "agent_runs_dedup_key_idx" },
    };

    assert.equal(uniqueViolationConstraint(wrapped), "agent_runs_dedup_key_idx");
  });

  test("returns null for a 23505 without a constraint name", () => {
    assert.equal(uniqueViolationConstraint({ code: "23505" }), null);
  });

  test("returns null for non-unique-violation and nullish errors", () => {
    assert.equal(uniqueViolationConstraint({ code: "23503", constraint: "some_fk" }), null);
    assert.equal(uniqueViolationConstraint(new Error("boom")), null);
    assert.equal(uniqueViolationConstraint(null), null);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isUniqueViolation } from "../../src/modules/agent/service";

/**
 * `isUniqueViolation` must recognize a Postgres 23505 even when Drizzle has
 * wrapped it. Drizzle wraps every driver error in a `DrizzleQueryError` whose
 * own `.code` is undefined; the node-postgres `DatabaseError` (which carries
 * `code: "23505"`) sits on `.cause`. The old top-level-only check returned
 * false for the wrapped error, so the chat-turn double-submit dedup catch
 * fell through to `throw err` → a 500 on the losing concurrent request instead
 * of returning the in-flight run. These lock the cause-chain walk.
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
    const cyclic: { code?: string; cause?: unknown } = {};
    cyclic.cause = cyclic;
    assert.equal(isUniqueViolation(cyclic), false);
  });
});

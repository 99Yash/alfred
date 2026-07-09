import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isObservationAppendConflict,
  isOrgAffiliationObservationAppendConflict,
} from "../../src/modules/user-model";

function pgError(fields: {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}): Error & {
  code?: string;
  constraint?: string;
  cause?: unknown;
} {
  const err = new Error(fields.message ?? "pg error") as Error & {
    code?: string;
    constraint?: string;
    cause?: unknown;
  };
  err.code = fields.code;
  err.constraint = fields.constraint;
  err.cause = fields.cause;
  return err;
}

describe("user-model pg error classifiers", () => {
  test("recognizes Drizzle-wrapped observation append conflicts on Error causes", () => {
    const driver = pgError({
      code: "23505",
      constraint: "observations_no_fork_idx",
    });
    const wrapped = new Error("Failed query") as Error & { cause?: unknown };
    wrapped.cause = driver;

    assert.equal(isObservationAppendConflict(wrapped), true);
    assert.equal(isOrgAffiliationObservationAppendConflict(wrapped), true);
  });

  test("requires the observation chain constraint, not just any unique violation", () => {
    const wrapped = new Error("Failed query") as Error & { cause?: unknown };
    wrapped.cause = pgError({
      code: "23505",
      constraint: "agent_runs_dedup_key_idx",
    });

    assert.equal(isObservationAppendConflict(wrapped), false);
    assert.equal(isOrgAffiliationObservationAppendConflict(wrapped), false);
  });

  test("observation classifier keeps the Drizzle message fallback", () => {
    const wrapped = new Error(
      "Failed query: duplicate key value violates unique constraint observations_single_root_idx (SQLSTATE 23505)",
    );

    assert.equal(isObservationAppendConflict(wrapped), true);
    assert.equal(isOrgAffiliationObservationAppendConflict(wrapped), false);
  });
});

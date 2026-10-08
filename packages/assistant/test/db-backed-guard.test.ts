import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decideDbBackedSkip } from "./support/db-backed";

// This suite reads no service variable, so a misconfigured CI job cannot skip it.
describe("decideDbBackedSkip", () => {
  test("runs when nothing is missing, on a laptop and in CI alike", () => {
    assert.deepEqual(decideDbBackedSkip({ missing: [], ci: false }), { kind: "run" });
    assert.deepEqual(decideDbBackedSkip({ missing: [], ci: true }), { kind: "run" });
  });

  test("skips outside CI and names every absent variable", () => {
    const decision = decideDbBackedSkip({ missing: ["DATABASE_URL", "REDIS_URL"], ci: false });
    assert.ok(decision.kind === "skip", `expected skip, got ${decision.kind}`);
    assert.match(decision.reason, /DATABASE_URL/);
    assert.match(decision.reason, /REDIS_URL/);
  });

  test("fails inside CI and names the absent variable and the job", () => {
    const decision = decideDbBackedSkip({ missing: ["DATABASE_URL"], ci: true });
    assert.ok(decision.kind === "fail", `expected fail, got ${decision.kind}`);
    assert.match(decision.message, /DATABASE_URL/);
    assert.match(decision.message, /assistant-unit-tests/);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setPreferenceArgsSchema } from "../../src/modules/memory/preferences";

describe("setPreferenceArgsSchema", () => {
  test("derives insert presence while allowing database-managed fields to stay omitted", () => {
    const parsed = setPreferenceArgsSchema.parse({
      userId: "usr_1",
      key: "tone",
      value: "concise",
    });

    assert.deepEqual(parsed, {
      userId: "usr_1",
      key: "tone",
      value: "concise",
    });
  });

  test("applies boundary refinements and the contract-owned JSONB schema", () => {
    assert.equal(
      setPreferenceArgsSchema.safeParse({ userId: "", key: "tone", value: "concise" }).success,
      false,
    );
    assert.equal(
      setPreferenceArgsSchema.safeParse({
        userId: "usr_1",
        key: "x".repeat(201),
        value: "concise",
      }).success,
      false,
    );
    assert.equal(
      setPreferenceArgsSchema.safeParse({
        userId: "usr_1",
        key: "tone",
        value: "concise",
        source: { kind: "invented" },
      }).success,
      false,
    );
  });

  test("uses the generated JSONB validator instead of accepting arbitrary runtime values", () => {
    assert.equal(
      setPreferenceArgsSchema.safeParse({
        userId: "usr_1",
        key: "tone",
        value: () => "not JSON",
      }).success,
      false,
    );
  });
});

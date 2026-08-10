import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { preferenceValueSchema, syncedPreferenceSchema } from "@alfred/sync";

describe("preference JSON contract", () => {
  test("accepts recursive JSON values", () => {
    const value = ["brief", 8, true, null, { nested: ["value"] }];

    assert.deepEqual(preferenceValueSchema.parse(value), value);
    assert.equal(
      syncedPreferenceSchema.safeParse({
        key: "example",
        userId: "user_1",
        value,
        source: { kind: "user" },
        rowVersion: 1,
      }).success,
      true,
    );
  });

  test("rejects non-JSON array members before sync or persistence", () => {
    const nonJsonValues: unknown[] = [
      [undefined],
      [new Date("2026-08-10T00:00:00.000Z")],
      [() => "not JSON"],
      [1n],
    ];

    for (const value of nonJsonValues) {
      assert.equal(preferenceValueSchema.safeParse(value).success, false);
    }
  });
});

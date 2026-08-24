import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { jsonValueSchema, toJsonValue } from "@alfred/contracts";

describe("toJsonValue", () => {
  test("normalizes values with JSON serialization semantics", () => {
    const input = {
      date: new Date("2026-08-10T00:00:00.000Z"),
      omitted: undefined,
      ignored: () => "not JSON",
      array: [undefined, () => "not JSON", "kept"],
    };

    const result = toJsonValue(input);

    assert.deepEqual(result, {
      date: "2026-08-10T00:00:00.000Z",
      array: [null, null, "kept"],
    });
    assert.equal(jsonValueSchema.safeParse(result).success, true);
  });

  test("maps top-level undefined to null", () => {
    assert.equal(toJsonValue(undefined), null);
  });

  test("degrades BigInt and cycles to a JSON marker", () => {
    const circular: Record<string, unknown> = {};
    Object.assign(circular, { self: circular });

    assert.deepEqual(toJsonValue(1n), { unserializable: "1" });
    assert.deepEqual(toJsonValue(circular), { unserializable: "[object Object]" });
  });
});

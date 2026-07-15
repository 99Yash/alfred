import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { registerBuiltinTools } from "../../src/modules/tools/index";
import { clearToolRegistryForTests, listRegisteredTools } from "../../src/modules/tools/registry";

/**
 * `listRegisteredTools()` is read on every discovery/search/preload/kernel
 * call, so it memoizes a frozen, sorted snapshot and rebuilds only when the
 * registry mutates. This pins both halves: the shared frozen reference reused
 * across reads, and its invalidation on register/clear.
 */
describe("listRegisteredTools snapshot", () => {
  after(() => clearToolRegistryForTests());

  test("returns a frozen, stable, sorted reference until the registry mutates", () => {
    clearToolRegistryForTests();
    registerBuiltinTools();

    const first = listRegisteredTools();
    const second = listRegisteredTools();
    assert.equal(first, second, "the same reference is reused across reads (memoized)");
    assert.ok(Object.isFrozen(first), "the snapshot is frozen so a caller cannot corrupt the cache");
    assert.ok(first.length > 0);

    const names = first.map((tool) => tool.name);
    assert.deepEqual(names, [...names].sort(), "the snapshot is sorted by name");
  });

  test("invalidates on clear and on re-registration", () => {
    clearToolRegistryForTests();
    registerBuiltinTools();
    const populated = listRegisteredTools();
    assert.ok(populated.length > 0);

    clearToolRegistryForTests();
    const empty = listRegisteredTools();
    assert.notEqual(empty, populated, "clear rebuilds the snapshot");
    assert.equal(empty.length, 0);

    registerBuiltinTools();
    const repopulated = listRegisteredTools();
    assert.notEqual(repopulated, empty, "registration rebuilds the snapshot");
    assert.ok(repopulated.length > 0);
  });
});

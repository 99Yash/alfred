import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RUNTIME_LATENCY_THRESHOLDS,
  boundedNameList,
  classifyLatency,
} from "../src/metering/runtime-span-metadata";

describe("classifyLatency", () => {
  test("pins the PRD default debug bands", () => {
    assert.deepEqual(RUNTIME_LATENCY_THRESHOLDS.tool_search, { yellowMs: 25, redMs: 100 });
    assert.deepEqual(RUNTIME_LATENCY_THRESHOLDS.schema_rebuild, { yellowMs: 50, redMs: 200 });
  });

  test("both edges are strictly-above, so a value on the edge stays healthier", () => {
    // tool_search: yellow >25, red >100
    assert.equal(classifyLatency("tool_search", 0), "ok");
    assert.equal(classifyLatency("tool_search", 25), "ok");
    assert.equal(classifyLatency("tool_search", 26), "yellow");
    assert.equal(classifyLatency("tool_search", 100), "yellow");
    assert.equal(classifyLatency("tool_search", 101), "red");

    // schema_rebuild: yellow >50, red >200
    assert.equal(classifyLatency("schema_rebuild", 50), "ok");
    assert.equal(classifyLatency("schema_rebuild", 51), "yellow");
    assert.equal(classifyLatency("schema_rebuild", 200), "yellow");
    assert.equal(classifyLatency("schema_rebuild", 201), "red");
  });
});

describe("boundedNameList", () => {
  test("returns null for an empty list so a no-names span reads as absent", () => {
    assert.equal(boundedNameList([]), null);
  });

  test("joins a short list verbatim", () => {
    assert.equal(
      boundedNameList(["gmail.search", "calendar.list_events"]),
      "gmail.search,calendar.list_events",
    );
  });

  test("caps a long list at 800 chars with an ellipsis", () => {
    const names = Array.from({ length: 200 }, (_, index) => `integration.action_${index}`);
    const result = boundedNameList(names);
    assert.ok(result);
    assert.equal(result.length, 800);
    assert.ok(result.endsWith("..."));
  });
});

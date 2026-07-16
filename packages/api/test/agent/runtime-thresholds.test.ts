import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RUNTIME_LATENCY_THRESHOLDS,
  classifyLatency,
} from "../../src/modules/agent/runtime-thresholds";

describe("classifyLatency", () => {
  test("pins the PRD default debug bands", () => {
    assert.deepEqual(RUNTIME_LATENCY_THRESHOLDS.tool_search, { yellowMs: 25, redMs: 100 });
    assert.deepEqual(RUNTIME_LATENCY_THRESHOLDS.schema_build, { yellowMs: 50, redMs: 200 });
  });

  test("both edges are strictly-above, so a value on the edge stays healthier", () => {
    // tool_search: yellow >25, red >100
    assert.equal(classifyLatency("tool_search", 0), "ok");
    assert.equal(classifyLatency("tool_search", 25), "ok");
    assert.equal(classifyLatency("tool_search", 26), "yellow");
    assert.equal(classifyLatency("tool_search", 100), "yellow");
    assert.equal(classifyLatency("tool_search", 101), "red");

    // schema_build: yellow >50, red >200
    assert.equal(classifyLatency("schema_build", 50), "ok");
    assert.equal(classifyLatency("schema_build", 51), "yellow");
    assert.equal(classifyLatency("schema_build", 200), "yellow");
    assert.equal(classifyLatency("schema_build", 201), "red");
  });
});

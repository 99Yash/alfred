import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RuntimeSpanEndArgs, RuntimeSpanInput } from "@alfred/ai";

import {
  RUNTIME_SCRATCH_PROMOTE,
  RUNTIME_SCRATCH_READ,
  RUNTIME_SCRATCH_SNAPSHOT,
  RUNTIME_SCRATCH_WRITE,
  _setScratchRuntimeSpanStarterForTests,
  buildScratchPromoteSpanInput,
  buildScratchReadSpanInput,
  buildScratchSnapshotSpanInput,
  buildScratchWriteSpanInput,
  hashScratchKey,
  startScratchSpan,
} from "../../src/modules/scratchpad/health";

const startedAt = new Date("2026-07-15T00:00:00.000Z");

describe("hashScratchKey", () => {
  test("is a stable, prefixed, bounded fingerprint — never the raw key", () => {
    const key = "scratch.sub1.private-findings";
    const hash = hashScratchKey(key);
    assert.equal(hash, hashScratchKey(key), "same input → same hash");
    assert.match(hash, /^sha256:[0-9a-f]{16}$/, "prefixed + 16 hex chars");
    assert.ok(!hash.includes(key), "raw key must not appear in the hash");
    assert.ok(!hash.includes("private-findings"), "raw path must not leak");
  });

  test("different logical keys hash differently", () => {
    assert.notEqual(hashScratchKey("shared.goal"), hashScratchKey("shared.plan"));
    assert.notEqual(hashScratchKey("scratch.subA.x"), hashScratchKey("scratch.subB.x"));
  });
});

describe("buildScratchReadSpanInput", () => {
  test("emits the stable name and hashed key identity, no raw key/path", () => {
    const input = buildScratchReadSpanInput({
      runId: "run_1",
      zone: "scratch",
      logicalKey: "scratch.subA.secret-topic",
      startedAt,
    });
    assert.equal(input.name, RUNTIME_SCRATCH_READ);
    assert.equal(input.name, "runtime.scratch.read");
    assert.equal(input.runId, "run_1");
    assert.equal(input.startedAt, startedAt);
    assert.deepEqual(input.metadata, {
      operation: "read",
      zone: "scratch",
      keyHash: hashScratchKey("scratch.subA.secret-topic"),
      keyLength: "scratch.subA.secret-topic".length,
    });
    // The raw logical key / path must never ride along in metadata.
    const serialized = JSON.stringify(input.metadata);
    assert.ok(!serialized.includes("secret-topic"));
    assert.ok(!serialized.includes("subA"));
  });
});

describe("buildScratchWriteSpanInput", () => {
  test("carries the writer identity alongside the hashed key", () => {
    const input = buildScratchWriteSpanInput({
      runId: "run_2",
      zone: "shared",
      logicalKey: "shared.goal",
      writtenBy: "boss",
      startedAt,
    });
    assert.equal(input.name, RUNTIME_SCRATCH_WRITE);
    assert.deepEqual(input.metadata, {
      operation: "write",
      zone: "shared",
      keyHash: hashScratchKey("shared.goal"),
      keyLength: "shared.goal".length,
      writtenBy: "boss",
    });
  });
});

describe("buildScratchPromoteSpanInput", () => {
  test("hashes both endpoints and records the fixed zone direction", () => {
    const input = buildScratchPromoteSpanInput({
      runId: "run_3",
      fromLogicalKey: "scratch.subA.draft",
      toLogicalKey: "shared.draft",
      writtenBy: "boss",
      startedAt,
    });
    assert.equal(input.name, RUNTIME_SCRATCH_PROMOTE);
    assert.deepEqual(input.metadata, {
      operation: "promote",
      fromZone: "scratch",
      toZone: "shared",
      fromKeyHash: hashScratchKey("scratch.subA.draft"),
      fromKeyLength: "scratch.subA.draft".length,
      toKeyHash: hashScratchKey("shared.draft"),
      toKeyLength: "shared.draft".length,
      writtenBy: "boss",
    });
    assert.ok(!JSON.stringify(input.metadata).includes("draft.")); // no raw dotted key
  });
});

describe("buildScratchSnapshotSpanInput", () => {
  test("is a bare snapshot marker — counts are folded at end, not here", () => {
    const input = buildScratchSnapshotSpanInput({ runId: "run_4", startedAt });
    assert.equal(input.name, RUNTIME_SCRATCH_SNAPSHOT);
    assert.equal(input.name, "runtime.scratch.snapshot");
    assert.deepEqual(input.metadata, { operation: "snapshot" });
  });
});

describe("startScratchSpan injectable seam", () => {
  test("routes the built input through the injected starter and forwards end args", () => {
    const opened: RuntimeSpanInput[] = [];
    const ended: RuntimeSpanEndArgs[] = [];
    const restore = _setScratchRuntimeSpanStarterForTests((input) => {
      opened.push(input);
      return {
        end(args) {
          ended.push(args);
        },
      };
    });
    try {
      const span = startScratchSpan(
        buildScratchReadSpanInput({
          runId: "run_5",
          zone: "shared",
          logicalKey: "shared.goal",
          startedAt,
        }),
      );
      span.end({ status: "ok", metadata: { hit: true, corrupt: false, byteSize: 42 } });
    } finally {
      restore();
    }
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.name, "runtime.scratch.read");
    assert.deepEqual(ended, [
      { status: "ok", metadata: { hit: true, corrupt: false, byteSize: 42 } },
    ]);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type Citation,
  isCitationKind,
  makeCitation,
  parseCitation,
  resolveCitations,
} from "@alfred/contracts";

describe("parseCitation", () => {
  test("splits at the first colon, preserving colons in the id", () => {
    const parsed = parseCitation("activity:github:pr:warden#9");
    assert.deepEqual(parsed, {
      kind: "activity",
      id: "github:pr:warden#9",
      citation: "activity:github:pr:warden#9",
    });
  });

  test("accepts every kind in the vocabulary", () => {
    for (const kind of ["email", "meeting", "todo", "memory", "activity"]) {
      assert.equal(parseCitation(`${kind}:x`)?.kind, kind);
    }
  });

  test("rejects unknown kinds, empty ids, and missing separators", () => {
    assert.equal(parseCitation("bogus:x"), null);
    assert.equal(parseCitation("email:"), null);
    assert.equal(parseCitation("email"), null);
    assert.equal(parseCitation(":x"), null);
  });
});

describe("makeCitation / isCitationKind", () => {
  test("makeCitation composes a kind:id string", () => {
    assert.equal(makeCitation("todo", "abc"), "todo:abc");
  });

  test("isCitationKind guards the closed set", () => {
    assert.equal(isCitationKind("memory"), true);
    assert.equal(isCitationKind("activity"), true);
    assert.equal(isCitationKind("nope"), false);
  });
});

describe("resolveCitations", () => {
  const entities = new Map<Citation, { label: string }>([
    ["meeting:evt1", { label: "Standup" }],
    ["todo:t1", { label: "Ship MEET-001" }],
  ]);

  test("segments prose into text and citation spans", () => {
    const result = resolveCitations("Prep for [[meeting:evt1]] today.", entities);
    assert.deepEqual(
      result.segments.map((s) => (s.kind === "text" ? s.text : s.entity.label)),
      ["Prep for ", "Standup", " today."],
    );
    assert.deepEqual(result.resolved, ["meeting:evt1"]);
    assert.deepEqual(result.unresolved, []);
  });

  test("falls back to inner text for tokens absent from the entity map", () => {
    const result = resolveCitations("See [[memory:unknown]].", entities);
    assert.deepEqual(
      result.segments.map((s) => (s.kind === "text" ? s.text : s.entity.label)),
      ["See ", "memory:unknown", "."],
    );
    assert.deepEqual(result.resolved, []);
    assert.deepEqual(result.unresolved, ["memory:unknown"]);
  });

  test("falls back for syntactically invalid kinds", () => {
    const result = resolveCitations("[[bogus:x]]", entities);
    assert.equal(result.segments.length, 1);
    assert.deepEqual(result.unresolved, ["bogus:x"]);
  });

  test("resolves adjacent tokens as separate segments", () => {
    const result = resolveCitations("[[meeting:evt1]][[todo:t1]]", entities);
    assert.deepEqual(result.resolved, ["meeting:evt1", "todo:t1"]);
    assert.equal(result.segments.every((s) => s.kind === "citation"), true);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BRIEFING_CONTEXT_SIGNAL_KINDS,
  BRIEFING_CONTEXT_SIGNALS,
  briefingContextSignalSchema,
  isBriefingContextSignalKind,
  isUserFactKey,
  MAX_BRIEFING_SIGNAL_EVIDENCE,
  MAX_BRIEFING_SIGNAL_SUMMARY_LENGTH,
} from "@alfred/contracts";

describe("briefing context signal taxonomy", () => {
  test("uses generic ways that evidence can matter, not domain-specific scenarios", () => {
    assert.deepEqual(BRIEFING_CONTEXT_SIGNAL_KINDS, [
      "development",
      "open_loop",
      "pattern",
      "constraint",
    ]);
  });

  test("the enum tuple and the metadata registry cover exactly the same kinds", () => {
    const fromRegistry = Object.keys(BRIEFING_CONTEXT_SIGNALS).sort();
    const fromTuple = [...BRIEFING_CONTEXT_SIGNAL_KINDS].sort();
    assert.deepEqual(fromTuple, fromRegistry);
  });

  test("every kind declares a non-empty description", () => {
    for (const kind of BRIEFING_CONTEXT_SIGNAL_KINDS) {
      assert.ok(
        BRIEFING_CONTEXT_SIGNALS[kind].description.trim().length > 0,
        `"${kind}" has an empty description`,
      );
    }
  });

  test("isBriefingContextSignalKind is a correct guard", () => {
    assert.equal(isBriefingContextSignalKind("development"), true);
    assert.equal(isBriefingContextSignalKind("shipping_momentum"), false);
    assert.equal(isBriefingContextSignalKind("toString"), false); // prototype-safe
  });
});

describe("briefing signal memory-write policy (ADR-0083 §3)", () => {
  test("signals are a namespace disjoint from user_facts keys", () => {
    for (const kind of BRIEFING_CONTEXT_SIGNAL_KINDS) {
      assert.equal(
        isUserFactKey(kind),
        false,
        `signal "${kind}" collides with a real user_facts key`,
      );
    }
  });
});

describe("briefingContextSignalSchema", () => {
  test("accepts a generic, evidence-backed description of what is happening", () => {
    const parsed = briefingContextSignalSchema.parse({
      kind: "open_loop",
      summary: "PR #42 is still awaiting review",
      evidence: ["email:thread_123"],
      confidence: 0.8,
    });
    assert.equal(parsed.kind, "open_loop");
    assert.equal(parsed.summary, "PR #42 is still awaiting review");
    assert.deepEqual(parsed.evidence, ["email:thread_123"]);
  });

  test("requires a summary because the generic kind does not encode the situation", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "development",
      evidence: ["activity:act_1"],
    });
    assert.equal(result.success, false);
  });

  test('"no grounding, no row" — evidence is non-empty by contract', () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "development",
      summary: "PR #42 merged",
      evidence: [],
    });
    assert.equal(result.success, false);
  });

  test("rejects an evidence token that is not a briefing reference", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "development",
      summary: "PR #42 merged",
      evidence: ["not-a-reference"],
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown signal kind", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "job_search_event",
      summary: "Interview moved to Tuesday",
      evidence: ["meeting:event_123"],
    });
    assert.equal(result.success, false);
  });

  test("bounds the evidence fan-out and summary", () => {
    const tooMuchEvidence = briefingContextSignalSchema.safeParse({
      kind: "pattern",
      summary: "Machine-generated notifications dominated the inbox",
      evidence: Array.from(
        { length: MAX_BRIEFING_SIGNAL_EVIDENCE + 1 },
        (_unused, i) => `activity:act_${i}`,
      ),
    });
    assert.equal(tooMuchEvidence.success, false);

    const summaryTooLong = briefingContextSignalSchema.safeParse({
      kind: "pattern",
      summary: "x".repeat(MAX_BRIEFING_SIGNAL_SUMMARY_LENGTH + 1),
      evidence: ["activity:act_1"],
    });
    assert.equal(summaryTooLong.success, false);
  });

  test("rejects unknown fields (strict)", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "open_loop",
      summary: "PR #42 is still awaiting review",
      evidence: ["email:thread_123"],
      durability: "grounded_projection",
    });
    assert.equal(result.success, false);
  });
});

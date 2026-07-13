import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BRIEFING_CONTEXT_SIGNAL_KINDS,
  BRIEFING_CONTEXT_SIGNALS,
  BRIEFING_SIGNAL_DURABILITIES,
  briefingContextSignalSchema,
  briefingSignalDurability,
  isBriefingContextSignalKind,
  isEphemeralBriefingSignal,
  isUserFactKey,
  MAX_BRIEFING_SIGNAL_DETAIL_LENGTH,
  MAX_BRIEFING_SIGNAL_EVIDENCE,
} from "@alfred/contracts";

describe("briefing context signal taxonomy", () => {
  test("includes the required first-pass kinds (ADR-0083 §1)", () => {
    const required = [
      "closed_work_loop",
      "open_work_loop",
      "shipping_momentum",
      "job_search_event",
      "recurring_machine_noise",
      "integration_access_gap",
    ] as const;
    for (const kind of required) {
      assert.ok(
        BRIEFING_CONTEXT_SIGNAL_KINDS.includes(kind),
        `expected taxonomy to include "${kind}"`,
      );
    }
  });

  test("the enum tuple and the metadata registry cover exactly the same kinds", () => {
    const fromRegistry = Object.keys(BRIEFING_CONTEXT_SIGNALS).sort();
    const fromTuple = [...BRIEFING_CONTEXT_SIGNAL_KINDS].sort();
    assert.deepEqual(fromTuple, fromRegistry);
  });

  test("every kind declares a known durability and a non-empty description", () => {
    for (const kind of BRIEFING_CONTEXT_SIGNAL_KINDS) {
      const def = BRIEFING_CONTEXT_SIGNALS[kind];
      assert.ok(
        (BRIEFING_SIGNAL_DURABILITIES as readonly string[]).includes(def.durability),
        `"${kind}" has an unknown durability`,
      );
      assert.ok(def.description.trim().length > 0, `"${kind}" has an empty description`);
    }
  });

  test("isBriefingContextSignalKind is a correct guard", () => {
    assert.equal(isBriefingContextSignalKind("closed_work_loop"), true);
    assert.equal(isBriefingContextSignalKind("employer"), false);
    assert.equal(isBriefingContextSignalKind("toString"), false); // prototype-safe
  });
});

describe("briefing signal memory-write policy (ADR-0083 §3)", () => {
  test("signals are a namespace disjoint from durable facts — a signal is never a user_facts key", () => {
    for (const kind of BRIEFING_CONTEXT_SIGNAL_KINDS) {
      assert.equal(
        isUserFactKey(kind),
        false,
        `signal "${kind}" collides with a real user_facts key — signals must never masquerade as durable facts`,
      );
    }
  });

  test("shipping momentum is the exact set of ephemeral, never-persistable signals", () => {
    const ephemeral = BRIEFING_CONTEXT_SIGNAL_KINDS.filter(isEphemeralBriefingSignal);
    assert.deepEqual(ephemeral, ["shipping_momentum"]);
    assert.equal(briefingSignalDurability("shipping_momentum"), "ephemeral_query_time");
  });

  test("grounded object-state signals may back a bounded projection", () => {
    assert.equal(isEphemeralBriefingSignal("closed_work_loop"), false);
    assert.equal(isEphemeralBriefingSignal("integration_access_gap"), false);
    assert.equal(briefingSignalDurability("job_search_event"), "grounded_projection");
  });
});

describe("briefingContextSignalSchema", () => {
  test('accepts a well-formed signal with a valid "<kind>:<id>" evidence token', () => {
    const parsed = briefingContextSignalSchema.parse({
      kind: "open_work_loop",
      evidence: ["email:thread_123"],
      confidence: 0.8,
      detail: "PR #42 still awaiting review",
    });
    assert.equal(parsed.kind, "open_work_loop");
    assert.deepEqual(parsed.evidence, ["email:thread_123"]);
  });

  test('"no grounding, no row" — evidence is non-empty by contract', () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "closed_work_loop",
      evidence: [],
    });
    assert.equal(result.success, false);
  });

  test("rejects an evidence token that is not a briefing reference", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "closed_work_loop",
      evidence: ["not-a-reference"],
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown signal kind", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "employer",
      evidence: ["email:thread_123"],
    });
    assert.equal(result.success, false);
  });

  test("bounds the evidence fan-out and the detail phrasing hint", () => {
    const tooMuchEvidence = briefingContextSignalSchema.safeParse({
      kind: "recurring_machine_noise",
      evidence: Array.from(
        { length: MAX_BRIEFING_SIGNAL_EVIDENCE + 1 },
        (_unused, i) => `activity:act_${i}`,
      ),
    });
    assert.equal(tooMuchEvidence.success, false);

    const detailTooLong = briefingContextSignalSchema.safeParse({
      kind: "shipping_momentum",
      evidence: ["activity:act_1"],
      detail: "x".repeat(MAX_BRIEFING_SIGNAL_DETAIL_LENGTH + 1),
    });
    assert.equal(detailTooLong.success, false);
  });

  test("rejects unknown fields (strict) — no smuggling durable narrative on the wire", () => {
    const result = briefingContextSignalSchema.safeParse({
      kind: "open_work_loop",
      evidence: ["email:thread_123"],
      durability: "grounded_projection", // derived from kind, never carried on the wire
    });
    assert.equal(result.success, false);
  });
});

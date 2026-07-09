import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  chatMemoryExtractionResultSchema,
  chatPropositionSchema,
  MAX_CHAT_PROPOSITIONS,
  PROPOSITION_ATTRIBUTIONS,
  VERIFICATION_CLASSES,
  VOLATILITY_CLASSES,
} from "@alfred/contracts";

/**
 * Pins the chat→memory proposition contract (chat-mem v1, #398; D4/D6): the
 * tagged shape the end-of-thread extractor emits and #399 consumes.
 */

const validUserProposition = {
  subject: "user" as const,
  key: "user_nickname",
  value: "yash",
  verificationClass: "self_evident" as const,
  volatility: "stable" as const,
  attribution: "user_assertion" as const,
  confidence: 0.95,
  rationale: "The user said to call them yash.",
};

const validEntityProposition = {
  subject: "entity" as const,
  subjectRef: "dvd@oliv.ai",
  key: "relationship:dvd@oliv.ai",
  value: { role: "co-founder" },
  verificationClass: "external_checkable" as const,
  volatility: "stable" as const,
  attribution: "user_correction" as const,
  confidence: 0.9,
  rationale: "User established dvd is a co-founder of Oliv.",
};

describe("chatPropositionSchema", () => {
  test("accepts a well-formed user proposition (atomic value)", () => {
    const parsed = chatPropositionSchema.parse(validUserProposition);
    assert.equal(parsed.subject, "user");
    assert.equal(parsed.value, "yash");
  });

  test("accepts an entity proposition with a shallow object value + subjectRef", () => {
    const parsed = chatPropositionSchema.parse(validEntityProposition);
    assert.equal(parsed.subjectRef, "dvd@oliv.ai");
    assert.deepEqual(parsed.value, { role: "co-founder" });
  });

  test("rejects an unknown verificationClass", () => {
    assert.throws(
      () => chatPropositionSchema.parse({ ...validUserProposition, verificationClass: "vibes" }),
      /verificationClass|enum|expected/i,
    );
  });

  test("rejects an unknown attribution", () => {
    assert.throws(
      () => chatPropositionSchema.parse({ ...validUserProposition, attribution: "made_it_up" }),
      /attribution|enum|expected/i,
    );
  });

  test("rejects an unknown volatility", () => {
    assert.throws(
      () => chatPropositionSchema.parse({ ...validUserProposition, volatility: "sometimes" }),
      /volatility|enum|expected/i,
    );
  });

  test("rejects a deep/nested value (structured-output safety: shallow only)", () => {
    assert.throws(
      () =>
        chatPropositionSchema.parse({
          ...validUserProposition,
          value: { nested: { too: "deep" } },
        }),
      /value|expected|invalid/i,
    );
  });

  test("rejects a missing rationale", () => {
    assert.throws(
      () => chatPropositionSchema.parse({ ...validUserProposition, rationale: undefined }),
      /rationale|required|expected/i,
    );
  });

  test("enum sets match the documented D4/D6 vocabularies", () => {
    assert.deepEqual(
      [...VERIFICATION_CLASSES],
      ["self_evident", "integration_checkable", "external_checkable", "user_only"],
    );
    assert.deepEqual([...VOLATILITY_CLASSES], ["stable", "volatile"]);
    assert.deepEqual(
      [...PROPOSITION_ATTRIBUTIONS],
      [
        "user_assertion",
        "user_correction",
        "user_confirmation",
        "user_rejection",
        "alfred_enrichment",
      ],
    );
  });
});

describe("chatMemoryExtractionResultSchema", () => {
  test("accepts an empty proposition list (the common outcome)", () => {
    assert.deepEqual(chatMemoryExtractionResultSchema.parse({ propositions: [] }), {
      propositions: [],
    });
  });

  test("accepts a mixed batch", () => {
    const parsed = chatMemoryExtractionResultSchema.parse({
      propositions: [validUserProposition, validEntityProposition],
    });
    assert.equal(parsed.propositions.length, 2);
  });

  test("rejects a batch over the cap", () => {
    assert.throws(
      () =>
        chatMemoryExtractionResultSchema.parse({
          propositions: Array.from({ length: MAX_CHAT_PROPOSITIONS + 1 }, () => validUserProposition),
        }),
      /too_big|at most|expected/i,
    );
  });
});

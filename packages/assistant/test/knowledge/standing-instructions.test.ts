import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  normalizeEmailAddress,
  SUPPRESSION_EFFECTS,
  rememberInput,
  standingInstructionTargetKey,
  standingInstructionValueSchema,
  type StandingInstructionValue,
} from "@alfred/contracts";

function instruction(overrides: Partial<StandingInstructionValue> = {}): StandingInstructionValue {
  return standingInstructionValueSchema.parse({
    schemaVersion: 1,
    action: "suppress",
    surface: "open_loop",
    target: {
      kind: "sender_email",
      email: "ben@example.com",
      label: "Ben Book",
      accountId: null,
    },
    effects: [...SUPPRESSION_EFFECTS],
    directive: "Stop surfacing reminders and briefing items from Ben Book.",
    phrasing: "stop emailing me about Ben Book",
    ...overrides,
  });
}

describe("normalizeEmailAddress", () => {
  test("extracts and canonicalizes an RFC-822 display address", () => {
    assert.equal(normalizeEmailAddress("Ben Book <BEN@Example.com>"), "ben@example.com");
  });

  test("returns null for an unresolved or malformed sender", () => {
    assert.equal(normalizeEmailAddress("Ben Book"), null);
    assert.equal(normalizeEmailAddress(""), null);
  });
});

describe("system.remember input vs persisted standing instruction schema", () => {
  test("tool input stays lenient so the handler can refuse an unresolved sender", () => {
    assert.equal(
      rememberInput.safeParse({
        kind: "standing_instruction",
        phrasing: "stop emailing me about Ben Book",
        directive: "Do not surface mail from Ben Book.",
        targets: ["Ben Book"],
        effects: ["block_todo_suggestion"],
      }).success,
      true,
    );
    assert.equal(
      rememberInput.safeParse({
        kind: "standing_instruction",
        phrasing: "stop emailing me about Ben Book",
        directive: "Do not surface mail from Ben Book.",
        effects: [],
      }).success,
      true,
    );
  });

  test("persisted standing instruction value is strict and canonical", () => {
    const parsed = standingInstructionValueSchema.parse({
      ...instruction(),
      target: {
        kind: "sender_email",
        email: " BEN@Example.com ",
        label: "Ben Book",
        accountId: null,
      },
    });

    assert.equal(standingInstructionTargetKey(parsed.target), "sender_email:ben@example.com");
    assert.equal(
      standingInstructionValueSchema.safeParse({
        ...instruction(),
        target: {
          kind: "sender_email",
          email: "Ben Book",
          label: "Ben Book",
          accountId: null,
        },
      }).success,
      false,
    );
  });
});

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

// Internal, not in the `knowledge` barrel.
import {
  senderSuppressionsOf,
  type ActiveSuppressionInstruction,
} from "@alfred/assistant/knowledge/standing-instructions";

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

function active(value: StandingInstructionValue): ActiveSuppressionInstruction {
  return {
    factId: "fact_1",
    value,
    validFrom: new Date("2026-06-15T00:00:00.000Z"),
  };
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

describe("senderSuppressions match", () => {
  test("matches cross-account sender suppressions by canonical email and effect", () => {
    const outcome = senderSuppressionsOf([active(instruction())]).match(
      { sender: "Ben Book <BEN@example.com>", accountId: "google-work" },
      "block_todo_suggestion",
    );

    assert.equal(outcome.kind, "suppressed");
    assert.equal(outcome.match.factId, "fact_1");
    assert.equal(outcome.match.matchedEmail, "ben@example.com");
  });

  test("honors account-specific suppressions when present", () => {
    const value = instruction({
      target: {
        kind: "sender_email",
        email: "ben@example.com",
        label: "Ben Book",
        accountId: "google-work",
      },
    });

    const suppressions = senderSuppressionsOf([active(value)]);

    assert.equal(
      suppressions.match(
        { sender: "ben@example.com", accountId: "google-personal" },
        "exclude_briefing_priority",
      ).kind,
      "none",
    );
    assert.equal(
      suppressions.match(
        { sender: "ben@example.com", accountId: "google-work" },
        "exclude_briefing_priority",
      ).kind,
      "suppressed",
    );
  });

  test("derives membership at read time — the stored effects array never filters", () => {
    const value = instruction({ effects: ["exclude_briefing_priority"] });
    assert.equal(
      senderSuppressionsOf([active(value)]).match(
        { sender: "ben@example.com", accountId: null },
        "block_todo_suggestion",
      ).kind,
      "suppressed",
    );
  });
});

describe("system.remember input vs persisted standing instruction schema", () => {
  test("tool input stays lenient so the handler can clarify unresolved senders", () => {
    assert.equal(
      rememberInput.safeParse({
        kind: "sender_suppression",
        senderEmail: "Ben Book",
        phrasing: "stop emailing me about Ben Book",
      }).success,
      true,
    );
    assert.equal(
      rememberInput.safeParse({
        kind: "sender_suppression",
        senderEmail: "Ben Book",
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

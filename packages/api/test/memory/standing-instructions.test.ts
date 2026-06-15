import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SUPPRESSION_EFFECTS,
  rememberInput,
  standingInstructionValueSchema,
  type StandingInstructionValue,
} from "@alfred/contracts";

import {
  findSenderSuppression,
  normalizeSenderEmail,
  type ActiveSuppressionInstruction,
} from "../../src/modules/memory/standing-instructions";

function instruction(
  overrides: Partial<StandingInstructionValue> = {},
): StandingInstructionValue {
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

describe("normalizeSenderEmail", () => {
  test("extracts and canonicalizes an RFC-822 display address", () => {
    assert.equal(normalizeSenderEmail("Ben Book <BEN@Example.com>"), "ben@example.com");
  });

  test("returns null for an unresolved or malformed sender", () => {
    assert.equal(normalizeSenderEmail("Ben Book"), null);
    assert.equal(normalizeSenderEmail(""), null);
  });
});

describe("findSenderSuppression", () => {
  test("matches cross-account sender suppressions by canonical email and effect", () => {
    const match = findSenderSuppression([active(instruction())], {
      senderEmail: "Ben Book <BEN@example.com>",
      accountId: "google-work",
      effect: "block_todo_suggestion",
    });

    assert.equal(match?.factId, "fact_1");
    assert.equal(match?.matchedEmail, "ben@example.com");
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

    assert.equal(
      findSenderSuppression([active(value)], {
        senderEmail: "ben@example.com",
        accountId: "google-personal",
        effect: "exclude_briefing_priority",
      }),
      null,
    );
    assert.equal(
      findSenderSuppression([active(value)], {
        senderEmail: "ben@example.com",
        accountId: "google-work",
        effect: "exclude_briefing_priority",
      })?.factId,
      "fact_1",
    );
  });

  test("does not match when the requested effect is absent", () => {
    const value = instruction({ effects: ["exclude_briefing_priority"] });
    assert.equal(
      findSenderSuppression([active(value)], {
        senderEmail: "ben@example.com",
        accountId: null,
        effect: "block_todo_suggestion",
      }),
      null,
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

    assert.equal(parsed.target.email, "ben@example.com");
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

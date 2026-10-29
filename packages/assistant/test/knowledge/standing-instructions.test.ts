import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  liftStandingInstructionV1,
  normalizeEmailAddress,
  SUPPRESSION_EFFECTS,
  rememberInput,
  standingInstructionTargetKey,
  standingInstructionValueSchema,
  type StandingInstructionValue,
} from "@alfred/contracts";

// Internal, not in the `knowledge` barrel.
import {
  standingInstructionsOf,
  type ActiveStandingInstruction,
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

function active(value: StandingInstructionValue): ActiveStandingInstruction {
  return {
    factId: "fact_1",
    value: liftStandingInstructionV1(value, "fact_1"),
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

describe("standingInstructions match", () => {
  test("matches cross-account sender suppressions by canonical email", () => {
    const mail = standingInstructionsOf([active(instruction())]).forMail({
      sender: "Ben Book <BEN@example.com>",
      accountId: "google-work",
    });

    assert.equal(mail.kind, "loaded");
    assert.equal(mail.targetHits.length, 1);
    const [hit] = mail.targetHits;
    assert.ok(hit);
    assert.equal(hit.factId, "fact_1");
    assert.equal(hit.matchedVia, "sender_email");
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

    const suppressions = standingInstructionsOf([active(value)]);

    assert.equal(
      suppressions.forMail({ sender: "ben@example.com", accountId: "google-personal" }).targetHits
        .length,
      0,
    );
    assert.equal(
      suppressions.forMail({ sender: "ben@example.com", accountId: "google-work" }).targetHits
        .length,
      1,
    );
  });

  test("lifts a v1 row to its enforced effects — the stored v1 array never filters", () => {
    const value = instruction({ effects: ["exclude_briefing_priority"] });

    const [hit] = standingInstructionsOf([active(value)]).forMail({
      sender: "ben@example.com",
      accountId: null,
    }).targetHits;

    assert.ok(hit);
    assert.ok(hit.value.effects.some((effect) => effect.kind === "block_todo_suggestion"));
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

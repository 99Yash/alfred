import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SenderContext } from "@alfred/contracts";
import { shouldDeepen, type DeepenDecision } from "../../src/modules/triage/deepen";
import type { TriageClassification } from "../../src/modules/triage/classify";

describe("shouldDeepen", () => {
  test("executes live for severity-suspect bots", () => {
    assert.deepEqual(
      shouldDeepen({
        classification: classification("fyi", 0.92),
        senderContext: botContext("sentry"),
      }),
      decision("execute", "severity_suspect_bot"),
    );
  });

  test("shadows low-confidence classifier outputs", () => {
    assert.deepEqual(
      shouldDeepen({
        classification: classification("meeting", 0.62),
        senderContext: { fromKind: "unknown", effectiveAuthor: "unknown" },
      }),
      decision("shadow", "low_confidence"),
    );
  });

  test("does not deepen ordinary review bot comments", () => {
    assert.deepEqual(
      shouldDeepen({
        classification: classification("fyi", 0.9),
        senderContext: botContext("coderabbit"),
      }),
      { mode: "skip" },
    );
  });

  test("shadows important unknown human senders", () => {
    assert.deepEqual(
      shouldDeepen({
        classification: classification("action_needed", 0.86),
        senderAddress: "alice@example.com",
        senderContext: { fromKind: "person", effectiveAuthor: "person" },
      }),
      decision("shadow", "unknown_human"),
    );
  });
});

function classification(
  category: TriageClassification["category"],
  confidence: number,
): TriageClassification {
  return {
    category,
    confidence,
    rationale: "fixture",
  };
}

function botContext(botSlug: NonNullable<SenderContext["botSlug"]>): SenderContext {
  return {
    fromKind: "service",
    effectiveAuthor: "bot",
    botSlug,
  };
}

function decision(mode: DeepenDecision["mode"], reason: NonNullable<DeepenDecision["reason"]>) {
  return { mode, reason };
}
